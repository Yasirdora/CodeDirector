/**
 * MCP server (`cdir mcp`) — the Code Director workflow as tools for any
 * MCP-capable agent (Gemini CLI first; Claude Code/Cursor later).
 *
 * stdio transport; the server operates on the directory it was started in
 * (or --root). Tool descriptions are written for the LLM consumer: they say
 * when to use each tool and in what order. Responses are concise text or
 * deterministic JSON (stableStringify); failures come back with isError so
 * the agent cannot miss them.
 *
 * Uses the SDK's low-level Server with plain JSON Schemas — no zod.
 */

import * as os from "node:os";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildIndex } from "../core/builder";
import { stableStringify } from "../core/store";
import { buildRepoMap, formatRepoMap } from "../core/map";
import { blastRadius, formatBlastRadius } from "../core/why";
import { draftLock, type DraftOptions } from "../lock/draft";
import { getProfile, mergeDraftOptions, PROFILE_NAMES } from "../lock/profiles";
import { checkLock } from "../lock/check";
import { loadLock, saveLock } from "../lock/store";
import { runWithLock } from "../run/run";
import { buildReport } from "../report/report";
import { formatReport, formatReportJson, formatReportMarkdown } from "../report/format";
import { latestCheckpoint, undo } from "../checkpoint";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
function json(value: unknown): ToolResult {
  return ok(stableStringify(value));
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (root: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

function str(p: Record<string, unknown>, k: string, required = true): string {
  const v = p[k];
  if (typeof v === "string" && v) return v;
  if (required) throw new Error(`missing required argument: ${k} (string)`);
  return "";
}

function strArray(p: Record<string, unknown>, k: string): string[] {
  const v = p[k];
  if (Array.isArray(v) && v.every((x) => typeof x === "string" && x)) return v as string[];
  throw new Error(`missing required argument: ${k} (array of non-empty strings)`);
}

/** Load the index, building it on demand when missing (quiet — stdio is protocol). */
async function indexFor(root: string) {
  const { index } = await buildIndex(root);
  return index;
}

/**
 * Resolve which project root a tool call operates on. Agents are often
 * launched from the user's home directory; without a guard the server would
 * happily index the entire home folder (multi-minute walks, locks written
 * to the wrong place). An explicit per-call `root` always wins; a defaulted
 * home-directory root is refused with instructions.
 */
export function resolveRoot(serverRoot: string, a: Record<string, unknown>): string {
  const explicit = a.root;
  if (typeof explicit === "string" && explicit.trim() !== "") return path.resolve(explicit);
  if (serverRoot === os.homedir()) {
    throw new Error(
      `codedirector was started in your home directory (${serverRoot}), not a project. ` +
        `Pass the project path as the "root" argument on every tool call ` +
        `(e.g. {"root": "/path/to/project", ...}), or restart the agent from inside the project folder.`
    );
  }
  return serverRoot;
}

/** Inject the optional per-call `root` override into a tool's input schema. */
function withRootParam(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  return {
    ...schema,
    properties: {
      ...props,
      root: {
        type: "string",
        description:
          "Absolute path of the project this call operates on. REQUIRED when the agent was " +
          "launched outside the project (e.g. from the home directory); otherwise omit.",
      },
    },
  };
}

const WORKFLOW =
  "Workflow: 0) if the human's request is vague, offer 2–4 concrete directions and ask them to pick — " +
  "NO tool calls, web searches, or repo scans before they answer; 1) lock_draft with the chosen direction, " +
  "2) show the proposed scope to the human, " +
  "3) lock_check then lock_activate, 4) run_locked for ALL file-changing work, 5) report. " +
  "Never edit files with your own write tools while a Lock is active for the task.";

const TOOLS: ToolDef[] = [
  {
    name: "repo_map",
    description:
      "Ranked map of the repository for a query — the symbols and files most relevant to a task, with anchors. " +
      "Use only AFTER the human has picked a direction, to draft the Lock — never for open-ended research " +
      "before scope is agreed. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are looking for, e.g. a symbol name or topic." },
        top: { type: "number", description: "Max symbols (default 30)." },
      },
      required: ["query"],
    },
    handler: async (root, a) => {
      const index = await indexFor(root);
      const query = str(a, "query");
      const top = typeof a.top === "number" && a.top > 0 ? a.top : 30;
      const result = buildRepoMap(index, query, { top, maxTokens: 1024 });
      if (result.anchors.length === 0) return fail(`no anchors matched "${query}" — the repo map is empty for this query`);
      return ok(formatRepoMap(result, query));
    },
  },
  {
    name: "blast_radius",
    description:
      "What a change to a symbol could break: direct and transitive callers, and the test files that cover it. " +
      "Use before proposing scope. Read-only.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Symbol name, e.g. ImagePipeline.render" } },
      required: ["symbol"],
    },
    handler: async (root, a) => {
      const index = await indexFor(root);
      const report = blastRadius(root, index, str(a, "symbol"));
      if (report.matches.length === 0) return fail("no such symbol — check the name with repo_map first");
      return ok(formatBlastRadius(report));
    },
  },
  {
    name: "lock_draft",
    description:
      "Draft an Intent Lock from the human's request (their words, verbatim). Returns the lock id, the YAML path, " +
      "and the proposed budget/deny scope. ALWAYS show the proposal to the human before activating. " +
      WORKFLOW,
    inputSchema: {
      type: "object",
      properties: {
        utterance: { type: "string", description: "The human's request, verbatim." },
        goal: { type: "string", description: "What must be true when done (optional; defaults to the utterance)." },
        profile: {
          type: "string",
          description:
            `Optional draft preset (available: ${PROFILE_NAMES.join(", ")}). "apple" denies Pods/Carthage/lockfiles/` +
            "signing assets/DerivedData (plus the generated .xcodeproj/.xcworkspace under XcodeGen or Tuist), " +
            "keeps no-new-dependency, and sets verifyCommand to swift test with a 15-minute timeout when Package.swift exists.",
        },
      },
      required: ["utterance"],
    },
    handler: async (root, a) => {
      const index = await indexFor(root);
      const goal = str(a, "goal", false);
      const profileName = str(a, "profile", false);
      let base: DraftOptions = {};
      if (profileName) {
        const profile = getProfile(profileName, root);
        if (!profile) return fail(`unknown profile "${profileName}" (available: ${PROFILE_NAMES.join(", ")})`);
        base = profile;
      }
      const result = draftLock(root, index, str(a, "utterance"), mergeDraftOptions(base, goal ? { goal } : {}));
      return json({
        lockId: result.lock.id,
        path: path.relative(root, result.path),
        status: result.lock.status,
        anchors: result.anchors.map((x) => x.qualifiedName),
        anchorStrength: result.anchorStrength,
        proposedBudget: result.proposedFiles,
        suggestedDeny: result.suggestedDeny,
        next: `show this scope to the human, then lock_check ${result.lock.id} and lock_activate ${result.lock.id}`,
      });
    },
  },
  {
    name: "lock_check",
    description: "Validate a draft Lock against the current repo index. Must pass before lock_activate. Read-only.",
    inputSchema: {
      type: "object",
      properties: { lockId: { type: "string", description: "e.g. IL-0001" } },
      required: ["lockId"],
    },
    handler: async (root, a) => {
      const lockId = str(a, "lockId");
      const lock = loadLock(root, lockId);
      if (!lock) return fail(`no such lock: ${lockId}`);
      const index = await indexFor(root);
      const result = checkLock(root, lock, index);
      return json({ lockId, ok: result.ok, errors: result.errors, warnings: result.warnings });
    },
  },
  {
    name: "lock_activate",
    description:
      "Move a draft Lock to active after the human has seen and accepted the proposed scope. " +
      "Only active Locks can run. Refuses when validation fails.",
    inputSchema: {
      type: "object",
      properties: { lockId: { type: "string", description: "e.g. IL-0001" } },
      required: ["lockId"],
    },
    handler: async (root, a) => {
      const lockId = str(a, "lockId");
      const lock = loadLock(root, lockId);
      if (!lock) return fail(`no such lock: ${lockId}`);
      if (lock.status !== "draft") return fail(`lock ${lockId} has status "${lock.status}" — only drafts can be activated`);
      const index = await indexFor(root);
      const result = checkLock(root, lock, index);
      if (!result.ok) return fail(`lock ${lockId} failed validation: ${result.errors.join("; ")}`);
      lock.status = "active";
      saveLock(root, lock);
      return ok(`${lockId} is now active — execute ONLY via run_locked ${lockId}`);
    },
  },
  {
    name: "run_locked",
    description:
      "THE guarded execution path: checkpoint, capture the pre-change baseline, run the command, classify every " +
      "touched file against the Lock (deny/budget), verify every KEEP clause, and return the Change Report " +
      "(plain summary on top). On violations or a failed command this returns an ERROR — show the report to the " +
      "human; nothing is auto-reverted (undo is available). " + WORKFLOW,
    inputSchema: {
      type: "object",
      properties: {
        lockId: { type: "string", description: "An active lock id, e.g. IL-0001" },
        command: {
          type: "array",
          items: { type: "string" },
          description: 'The command as argv, e.g. ["node", "scripts/build.js"]. Runs in the repo root.',
        },
      },
      required: ["lockId", "command"],
    },
    handler: async (root, a) => {
      const lockId = str(a, "lockId");
      const command = strArray(a, "command");
      const outcome = await runWithLock(root, lockId, command, { stdio: "pipe" });
      const report = await buildReport(root, lockId, {
        verification: outcome.record.verification,
        run: outcome.record,
        runRecordPath: outcome.recordPath,
      });
      const body = formatReport(report);
      if (outcome.exitCode === 0) {
        return ok(`run ${lockId} succeeded — no violations.\n\n${body}`);
      }
      return fail(
        `run ${lockId} FAILED (exit ${outcome.exitCode}) — violations below. ` +
          `Do not retry blindly; show this report to the human. Nothing was reverted — undo() restores the checkpoint.\n\n${body}`,
      );
    },
  },
  {
    name: "report",
    description:
      "The latest Change Report for a Lock: the plain-language summary, then changed files with their " +
      "classification, every check with its evidence class, and the Unchecked bucket. Always finish a task with this.",
    inputSchema: {
      type: "object",
      properties: {
        lockId: { type: "string", description: "e.g. IL-0001" },
        format: { type: "string", enum: ["terminal", "md", "json"], description: "default terminal" },
      },
      required: ["lockId"],
    },
    handler: async (root, a) => {
      const lockId = str(a, "lockId");
      const format = str(a, "format", false) || "terminal";
      const report = await buildReport(root, lockId);
      if (format === "md") return ok(formatReportMarkdown(report));
      if (format === "json") return ok(formatReportJson(report));
      return ok(formatReport(report));
    },
  },
  {
    name: "undo",
    description:
      "Restore the working tree to the latest checkpoint (git reset + the checkpoint-time byte snapshot). " +
      "Untracked files created after the checkpoint are deleted and listed. Refuses over a dirty-tree checkpoint " +
      "without force — pass force only when the human explicitly asked to discard that work.",
    inputSchema: {
      type: "object",
      properties: { force: { type: "boolean", description: "required when the checkpoint covered a dirty tree" } },
    },
    handler: async (root, a) => {
      const ckpt = latestCheckpoint(root);
      if (!ckpt) return fail("no checkpoint recorded — nothing to undo");
      const result = undo(root, { force: a.force === true });
      return json({
        restoredTag: result.checkpoint.tag,
        ref: result.checkpoint.ref,
        forced: result.forced,
        discardedChanges: result.lostFiles,
        deletedUntracked: result.deletedUntracked,
      });
    },
  },
];

export async function startMcpServer(rootDir: string): Promise<void> {
  const root = path.resolve(rootDir);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const version: string = require("../../../package.json").version;
  const server = new Server(
    { name: "codedirector", version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: withRootParam(t.inputSchema) })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) return fail(`unknown tool: ${req.params.name}`);
    try {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      return await tool.handler(resolveRoot(root, args), args);
    } catch (e) {
      return fail(`${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until the client disconnects; then let main() exit 0.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
