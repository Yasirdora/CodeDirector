/**
 * Flight recorder for the MCP server.
 *
 * Every tool call leaves one JSON line at `.codedirector/mcp.log`: when it
 * started, which tool, which root, how long it took, and how it ended. The
 * need is not analytics — it is that a call which appears to hang can be
 * reconstructed afterwards instead of guessed at.
 *
 * JSON Lines rather than anything compact, because the file is read by a
 * person at the moment something has gone wrong, and `grep` is the tool they
 * will reach for.
 *
 * Two properties this module owes its caller, in order of importance:
 *
 *  1. A log line is never worth a tool result. Every write is wrapped — a
 *     full disk, a read-only directory, a root that does not exist — and the
 *     cost of any of them is a missing line, never a failed call.
 *  2. The line is written when the call COMPLETES, because duration and
 *     outcome do not exist before then. A process killed mid-call therefore
 *     leaves no line at all. That is a real limitation and is stated here
 *     rather than pretended away: the gap between the last line and the
 *     process's death is itself the evidence of the call that never
 *     returned. Writing a start line and an end line would close the gap at
 *     the cost of doubling the file and complicating rotation; if a hang ever
 *     needs more than this, that is the trade to revisit.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Roll the log past this size, keeping exactly one previous file. */
export const ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * How a call ended.
 *  - "ok":    the tool returned a result
 *  - "error": the tool returned a result marked isError (a refusal, a
 *             violation — the workflow working, not a crash)
 *  - "threw": the handler raised, and the server turned it into an error
 */
export type CallOutcome = "ok" | "error" | "threw";

export interface CallRecord {
  /** ISO timestamp of when the call STARTED — a hang is a start with no end. */
  at: string;
  tool: string;
  root: string;
  durationMs: number;
  outcome: CallOutcome;
}

export function logPath(rootDir: string): string {
  return path.join(rootDir, ".codedirector", "mcp.log");
}

/**
 * Append one record. Never throws.
 *
 * Arguments are deliberately absent from `CallRecord`: they carry the
 * human's verbatim utterances and their file paths, and what this file
 * exists to answer is "what took three minutes", not "what was said".
 */
export function recordCall(rootDir: string, record: CallRecord): void {
  try {
    const file = logPath(rootDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfFull(file);
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* see property 1 above */
  }
}

/**
 * Roll `mcp.log` to `mcp.log.1` once it passes the cap, replacing any
 * previous `.1`. Rename rather than copy: it is atomic on every platform
 * this runs on, so a reader never sees a half-moved file.
 */
function rotateIfFull(file: string): void {
  try {
    if (fs.statSync(file).size < ROTATE_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* no log yet, or another process rotated first — either is fine */
  }
}
