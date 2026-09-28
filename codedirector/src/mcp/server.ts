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
import { KEEP_CLAUSE_KINDS, type KeepClause } from "../lock/types";
import { describeProfiles, getProfile, mergeDraftOptions, PROFILE_NAMES } from "../lock/profiles";
import { checkLock } from "../lock/check";
import { loadLock, saveLock } from "../lock/store";
import { sealLock } from "../lock/seal";
import { runWithLock } from "../run/run";
import { buildReport } from "../report/report";
import { formatReport, formatReportJson, formatReportMarkdown } from "../report/format";
import { latestCheckpoint, undo } from "../checkpoint";
import { recordCall, type CallOutcome } from "./log";

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

// ---------------------------------------------------------------------
// Draft/amend arguments shared by lock_draft and lock_amend. Every field is
// validated here with the rules `lock check` will apply later, so a draft
// cannot be born invalid.

const KEEP_ARG_SCHEMA: Record<string, unknown> = {
  type: "array",
  description:
    "KEEP clauses the change must preserve. Propose them from the task: tests-pass when the repo has " +
    "runnable tests, api-unchanged for exported symbols the change touches, no-new-dependency when the " +
    "change should not touch manifests. Kinds: api-unchanged {symbols:[\"<file>#<symbol>\"]}, tests-pass " +
    "{glob}, output-unchanged {command}, no-new-dependency {}, custom {text} (human-judged).",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: KEEP_CLAUSE_KINDS },
      symbols: { type: "array", items: { type: "string" }, description: "api-unchanged: \"<file>#<symbol>\" ids." },
      glob: { type: "string", description: "tests-pass: the test-file glob that must keep passing." },
      command: { type: "string", description: "output-unchanged: the command whose output must not change." },
      fixtures: { type: "array", items: { type: "string" }, description: "output-unchanged: fixture paths." },
      text: { type: "string", description: "custom: free text — always human-judged." },
    },
    required: ["kind"],
  },
};

const STRING_ARRAY = (description: string): Record<string, unknown> => ({
  type: "array",
  items: { type: "string" },
  description,
});

/** The fields lock_draft and lock_amend share; a provided value replaces what is there. */
const AMENDABLE_PROPS: Record<string, unknown> = {
  keep: KEEP_ARG_SCHEMA,
  deny: STRING_ARRAY("Paths/globs the change must not touch."),
  budgetFiles: STRING_ARRAY("Files (or globs) the change may touch — replaces the anchor-proposed budget."),
  accept: STRING_ARRAY("Acceptance criteria in words; shown in reports, human-judged."),
  verifyCommand: { type: "string", description: "Optional harness executed as measured evidence, e.g. \"npm test\"." },
  verifyCovers: STRING_ARRAY("Languages the harness exercises when its text cannot say (the coverage escape hatch)."),
  maxFiles: { type: "number", description: "Ceiling on changed files (default: budgetFiles length)." },
  maxLines: { type: "number", description: "Ceiling on changed lines (default 400)." },
};

function optionalStringArray(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x)) {
    throw new Error(`${where} must be an array of non-empty strings`);
  }
  return v as string[];
}

function parseKeepArg(raw: unknown, where: string): KeepClause {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object with a "kind"`);
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.kind !== "string" || !(KEEP_CLAUSE_KINDS as readonly string[]).includes(c.kind)) {
    throw new Error(
      `${where}.kind must be one of: ${KEEP_CLAUSE_KINDS.join(", ")} — api-unchanged needs symbols[], ` +
        `tests-pass needs glob, output-unchanged needs command, custom needs text`,
    );
  }
  const kind = c.kind as KeepClause["kind"];
  switch (kind) {
    case "api-unchanged": {
      const symbols = optionalStringArray(c.symbols, `${where}.symbols`);
      if (!symbols || symbols.length === 0) {
        throw new Error(`${where} (api-unchanged) needs a non-empty symbols[] of "<file>#<symbol>" ids`);
      }
      return { kind, symbols };
    }
    case "tests-pass": {
      if (typeof c.glob !== "string" || !c.glob) throw new Error(`${where} (tests-pass) needs a glob string`);
      return { kind, glob: c.glob };
    }
    case "output-unchanged": {
      if (typeof c.command !== "string" || !c.command) throw new Error(`${where} (output-unchanged) needs a command string`);
      const fixtures = optionalStringArray(c.fixtures, `${where}.fixtures`);
      return { kind, command: c.command, ...(fixtures !== undefined ? { fixtures } : {}) };
    }
    case "custom": {
      if (typeof c.text !== "string" || !c.text) throw new Error(`${where} (custom) needs non-empty text`);
      return { kind, text: c.text };
    }
    case "no-new-dependency":
      return { kind };
  }
}

function keepClauses(v: unknown): KeepClause[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error("keep must be an array of clause objects");
  return v.map((c, i) => parseKeepArg(c, `keep[${i}]`));
}

/** Draft/amend arguments as DraftOptions; fields left out stay undefined. */
function draftArgsFrom(p: Record<string, unknown>): DraftOptions {
  const out: DraftOptions = {};
  const keep = keepClauses(p.keep);
  if (keep !== undefined) out.keep = keep;
  const deny = optionalStringArray(p.deny, "deny");
  if (deny !== undefined) out.deny = deny;
  const budgetFiles = optionalStringArray(p.budgetFiles, "budgetFiles");
  if (budgetFiles !== undefined) out.budgetFiles = budgetFiles;
  const accept = optionalStringArray(p.accept, "accept");
  if (accept !== undefined) out.accept = accept;
  if (typeof p.verifyCommand === "string" && p.verifyCommand) out.verifyCommand = p.verifyCommand;
  const verifyCovers = optionalStringArray(p.verifyCovers, "verifyCovers");
  if (verifyCovers !== undefined) out.verifyCovers = verifyCovers;
  if (typeof p.maxFiles === "number" && Number.isFinite(p.maxFiles) && p.maxFiles > 0) out.maxFiles = Math.floor(p.maxFiles);
  if (typeof p.maxLines === "number" && Number.isFinite(p.maxLines) && p.maxLines > 0) out.maxLines = Math.floor(p.maxLines);
  return out;
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
      "and the proposed scope. Every anchor comes back defended — the file it came from and the word that put it " +
      "there — and a draft whose anchors are only name fragments, or which all land outside the repo's own " +
      "language, comes back with confidence \"low\": confirm the territory with the human before you trust the " +
      "budget. Pass the promises with the draft — keep clauses, verifyCommand, accept, budget, deny — so the " +
      "report can verify something. ALWAYS show the proposal to the human before activating. " +
      WORKFLOW,
    inputSchema: {
      type: "object",
      properties: {
        utterance: { type: "string", description: "The human's request, verbatim." },
        goal: { type: "string", description: "What must be true when done (optional; defaults to the utterance)." },
        profile: {
          type: "string",
          description: describeProfiles(),
        },
        ...AMENDABLE_PROPS,
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
      const explicit = draftArgsFrom(a);
      if (goal) explicit.goal = goal;
      const result = draftLock(root, index, str(a, "utterance"), mergeDraftOptions(base, explicit));
      return json({
        ...(result.confidence.low
          ? { confidence: "low", confirmTerritory: result.confidence.reasons }
          : {}),
        lockId: result.lock.id,
        path: path.relative(root, result.path),
        status: result.lock.status,
        keep: result.lock.keep,
        ...(result.lock.verifyCommand ? { verifyCommand: result.lock.verifyCommand } : {}),
        ...(result.lock.verifyCovers ? { verifyCovers: result.lock.verifyCovers } : {}),
        accept: result.lock.accept,
        budget: result.lock.budget,
        deny: result.lock.deny,
        anchors: result.anchors.map((x) => x.qualifiedName),
        anchorDefense: result.anchorDefense.map((d) => d.line),
        anchorStrength: result.anchorStrength,
        proposedBudget: result.proposedFiles,
        suggestedDeny: result.suggestedDeny,
        next: `show this scope to the human, then lock_check ${result.lock.id} and lock_activate ${result.lock.id}`,
      });
    },
  },
  {
    name: "lock_amend",
    description:
      "Patch a DRAFT Lock — budget, deny, KEEP clauses, verifyCommand, accept, ceilings — and re-validate it. " +
      "Refuses any Lock that is not a draft: an approved contract changes only through the user's re-approval. " +
      "Provided fields replace what is there; fields left out are untouched. Show the updated scope to the human " +
      "before activating. " + WORKFLOW,
    inputSchema: {
      type: "object",
      properties: {
        lockId: { type: "string", description: "e.g. IL-0001 (must be a draft)" },
        goal: { type: "string", description: "Optional replacement for the draft's goal." },
        interpretation: { type: "string", description: "Optional replacement for the draft's interpretation." },
        ...AMENDABLE_PROPS,
      },
      required: ["lockId"],
    },
    handler: async (root, a) => {
      const lockId = str(a, "lockId");
      const lock = loadLock(root, lockId);
      if (!lock) return fail(`no such lock: ${lockId}`);
      if (lock.status !== "draft") {
        return fail(
          `lock ${lockId} has status "${lock.status}" — only a draft can be amended with a tool. ` +
            `Changing an approved contract is the user's call: they edit it, then ` +
            `\`cdir lock check ${lockId}\` and \`cdir lock activate ${lockId}\` re-seal the new scope.`,
        );
      }
      const args = draftArgsFrom(a);
      if (args.keep !== undefined) lock.keep = args.keep;
      if (args.deny !== undefined) lock.deny = args.deny;
      if (args.budgetFiles !== undefined) lock.budget.files = args.budgetFiles;
      if (args.accept !== undefined) lock.accept = args.accept;
      if (args.verifyCommand !== undefined) lock.verifyCommand = args.verifyCommand;
      if (args.verifyCovers !== undefined) lock.verifyCovers = args.verifyCovers;
      if (args.maxFiles !== undefined) lock.budget.maxFiles = args.maxFiles;
      if (args.maxLines !== undefined) lock.budget.maxLines = args.maxLines;
      const goal = str(a, "goal", false);
      if (goal) lock.goal = goal;
      const interpretation = str(a, "interpretation", false);
      if (interpretation) lock.interpretation = interpretation;

      const saved = saveLock(root, lock);
      const index = await indexFor(root);
      const result = checkLock(root, lock, index);
      return json({
        lockId,
        path: path.relative(root, saved),
        ok: result.ok,
        errors: result.errors,
        warnings: result.warnings,
        keep: lock.keep,
        ...(lock.verifyCommand ? { verifyCommand: lock.verifyCommand } : {}),
        ...(lock.verifyCovers ? { verifyCovers: lock.verifyCovers } : {}),
        accept: lock.accept,
        budget: lock.budget,
        deny: lock.deny,
        next: result.ok
          ? `show the updated scope to the human, then lock_activate ${lockId}`
          : `fix the errors, then lock_check ${lockId}`,
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
      // draft → active, or re-approval of a Lock that can still run (active, verified,
      // failed) after a seal mismatch. Only abandoned is history.
      if (lock.status === "abandoned") {
        return fail(`lock ${lockId} has status "${lock.status}" — it cannot be activated`);
      }
      const index = await indexFor(root);
      const result = checkLock(root, lock, index);
      if (!result.ok) return fail(`lock ${lockId} failed validation: ${result.errors.join("; ")}`);
      lock.status = "active";
      saveLock(root, lock);
      sealLock(root, lock); // the approval seals the contract
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
        testTimeoutMs: {
          type: "number",
          description: "Optional timeout (ms) for test runs and the lock's verifyCommand; overrides the lock's verifyTimeoutMs (default 60s).",
        },
      },
      required: ["lockId", "command"],
    },
    handler: async (root, a) => {
      const lockId = str(a, "lockId");
      const command = strArray(a, "command");
      const testTimeoutMs = typeof a.testTimeoutMs === "number" && a.testTimeoutMs > 0 ? a.testTimeoutMs : undefined;
      const outcome = await runWithLock(root, lockId, command, {
        stdio: "pipe",
        ...(testTimeoutMs !== undefined ? { verifyOptions: { testTimeoutMs } } : {}),
      });
      const report = await buildReport(root, lockId, {
        verification: outcome.record.verification,
        run: outcome.record,
        runRecordPath: outcome.recordPath,
      });
      const body = formatReport(report);
      if (outcome.exitCode === 0) {
        return ok(`run ${lockId} succeeded — no violations.\n\n${body}`);
      }
      if (report.verdict === "incomplete") {
        return fail(
          `run ${lockId} is NOT VERIFIED — a declared check did not run; the report names it. ` +
            `Do not claim success; show this report to the human.\n\n${body}`,
        );
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

  // One dispatch point for every tool, which is why the flight recorder
  // lives here: a tool added later cannot forget to be recorded.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const at = new Date().toISOString();
    const started = process.hrtime.bigint();
    let resolved = "";
    let outcome: CallOutcome = "ok";
    try {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        outcome = "error";
        return fail(`unknown tool: ${name}`);
      }
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      // Hoisted out of the handler call so the record knows which root the
      // call was against even when the handler itself fails.
      resolved = resolveRoot(root, args);
      const result = await tool.handler(resolved, args);
      outcome = result.isError ? "error" : "ok";
      return result;
    } catch (e) {
      outcome = "threw";
      return fail(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // `resolveRoot` refuses a defaulted home directory, so a call can end
      // without any root at all. Log it against the server's own when that
      // is a real project, and drop it rather than guess when it is not.
      const where = resolved || (root === os.homedir() ? "" : root);
      if (where) {
        recordCall(where, {
          at,
          tool: name,
          root: where,
          durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          outcome,
        });
      }
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until the client disconnects; then let main() exit 0.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
