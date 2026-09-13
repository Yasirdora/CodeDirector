/**
 * Agent-hook bridge: `cdir hook` implements the PreToolUse hook contract
 * used by agent CLIs (agent lifecycle hooks and compatible systems).
 *
 * The agent writes a JSON payload to stdin — at minimum
 * { tool_name, tool_input, cwd } — and this module decides whether the
 * tool call may proceed:
 *
 *   - exit 0: allow. stdout may carry a JSON { "message": ... } reminder.
 *   - exit 2: block. stderr carries the reason; the agent receives it as a
 *     failed tool result and can choose an alternative.
 *   - anything unexpected: fail OPEN (allow). A misbehaving fence must
 *     never brick a session; per the hook contract, blocking is reserved
 *     for clear violations, and real safety still relies on `cdir run`
 *     verification after the fact.
 *
 * Semantics when a Lock is active (status: active, highest id wins):
 *   - target under .codedirector/      → allow (the layer manages itself)
 *   - target outside the project root  → block (out of jurisdiction)
 *   - target matches a deny entry      → block
 *   - target outside budget.files      → block
 * Only file membership is enforced per edit; maxFiles / maxLines stay
 * with the run-time classifier, which sees the whole change.
 */

import * as path from "node:path";
import { listLocks } from "../lock/store";
import { matchPath } from "../lock/glob";
import { VibeCheck } from "../lock/types";

export interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export type HookDecision =
  | { action: "allow" }
  | { action: "remind"; message: string }
  | { action: "block"; reason: string };

/** Tool names that modify files; agents name these differently. */
const EDIT_TOOL_RE = /edit|write|create|notebook/i;

/** Best-effort extraction of the file a tool call wants to modify. */
export function targetFileOf(toolInput: Record<string, unknown>): string | null {
  for (const key of ["file_path", "filePath", "path", "notebook_path", "filename", "target_file"]) {
    const v = toolInput[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/** Most recent active Lock, or null. Drafts and finished Locks do not gate. */
export function activeLock(rootDir: string): VibeCheck | null {
  const active = listLocks(rootDir).filter((l) => l.status === "active");
  return active.length > 0 ? active[active.length - 1] : null;
}

const NO_LOCK_MESSAGE =
  "codedirector: no active Vibe Check for this project. " +
  "Draft one (lock_draft / cdir lock new) and wait for the user's approval before editing.";

/**
 * Decide whether an edit-ish tool call may proceed. Pure apart from reading
 * Lock files under rootDir — no writes, no subprocesses, no throws by design.
 */
export function decidePreToolUse(rootDir: string, payload: HookPayload): HookDecision {
  try {
    const toolName = payload.tool_name ?? "";
    if (!EDIT_TOOL_RE.test(toolName)) return { action: "allow" };

    const lock = activeLock(rootDir);
    if (!lock) return { action: "remind", message: NO_LOCK_MESSAGE };

    const target = payload.tool_input ? targetFileOf(payload.tool_input) : null;
    if (!target) return { action: "allow" }; // unknown shape — fail open

    const abs = path.resolve(rootDir, target);
    const rel = path.relative(rootDir, abs).split(path.sep).join("/");
    if (rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) {
      return {
        action: "block",
        reason:
          `codedirector: ${target} is outside the project root. ` +
          `Active Vibe Check ${lock.id} ("${lock.utterance}") only covers files inside this repository.`,
      };
    }
    if (rel === ".codedirector" || rel.startsWith(".codedirector/")) {
      return { action: "allow" }; // the layer may manage its own state
    }

    for (const pattern of lock.deny) {
      if (matchPath(pattern, rel)) {
        return {
          action: "block",
          reason:
            `codedirector: ${rel} is on the deny list of active Vibe Check ${lock.id} ` +
            `("${lock.utterance}"). Do not modify it. If the work genuinely requires it, ` +
            `ask the user — the Lock must change, not the rule.`,
        };
      }
    }

    const inBudget = lock.budget.files.some((f) => matchPath(f, rel));
    if (!inBudget) {
      return {
        action: "block",
        reason:
          `codedirector: ${rel} is outside the approved budget of active Vibe Check ${lock.id} ` +
          `("${lock.utterance}"). Budget: ${lock.budget.files.join(", ")}. ` +
          `If this file is truly needed, stop and ask the user to widen the scope — ` +
          `do not expand it yourself.`,
      };
    }
    return { action: "allow" };
  } catch {
    return { action: "allow" }; // fail open, always
  }
}

/** Read all of stdin; resolves with the raw text (possibly empty). */
export function readStdin(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

/**
 * CLI entry for `cdir hook`. Maps the decision onto the hook contract:
 * allow → exit 0 (reminders as a JSON message on stdout), block → exit 2
 * with the reason on stderr. Unparseable payloads fail open.
 */
export async function runHookCommand(rootDir: string, stdinText: string): Promise<number> {
  let payload: HookPayload = {};
  try {
    if (stdinText.trim() !== "") payload = JSON.parse(stdinText);
  } catch {
    return 0; // fail open
  }
  const root = payload.cwd ? path.resolve(payload.cwd) : rootDir;
  const decision = decidePreToolUse(root, payload);
  switch (decision.action) {
    case "block":
      process.stderr.write(decision.reason + "\n");
      return 2;
    case "remind":
      process.stdout.write(JSON.stringify({ message: decision.message }) + "\n");
      return 0;
    default:
      return 0;
  }
}
