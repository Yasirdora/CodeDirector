/**
 * A verifyCommand run as named checks.
 *
 * A drafted verifyCommand is the run texts of the checks in
 * .codedirector/checks.yaml, joined by " && " (config/checks.ts, joinRuns).
 * While it is still exactly that, it runs as named steps: the same text, in
 * the same one shell, with a marker before each check and one after the
 * last. A marker creates an empty file in a folder outside the repo and
 * prints nothing; it cannot fail, so the `&&` chain decides exactly as the
 * text without markers would — same order, same shell state, same output,
 * same exit code. What the markers add is when each check started: progress
 * while the run goes on, and each check's time in the record afterwards.
 *
 * A verifyCommand that is not such a join — written by hand, or edited after
 * drafting — runs as written, as one step, as it always did.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CheckDef } from "../config/checks";

/** One check of the verifyCommand: its name in checks.yaml and its exact text. */
export interface CheckStep {
  name: string;
  run: string;
  /** Where the check leaves its result files, when checks.yaml says. */
  results?: string;
}

/** What one check of a run did, read from its markers. */
export interface StepTime {
  name: string;
  /** When the check started (ISO); absent when it never started. */
  startedAt?: string;
  /** How long it ran; absent when it never started. */
  durationMs?: number;
  /**
   * passed: the next marker was reached (or, for the last, the end marker).
   * failed: the run ended in this check with a non-zero exit.
   * stopped: the run ended in this check on the timeout.
   * ended: the run ended in this check with exit 0 before the next marker —
   *   the shell itself stopped (an `exit`, an `exec`, a `#` that swallowed
   *   the rest), so the checks after it never started.
   * not-started: the run ended before this check.
   */
  outcome: "passed" | "failed" | "stopped" | "ended" | "not-started";
}

/** The environment variable that names the marker folder for the shell. */
export const STEP_DIR_ENV = "CDIR_STEP_DIR";

const JOIN = " && ";

/** The marker for step `name`: an empty file, no output, status 0 even when it cannot be written. */
function marker(name: string): string {
  // `true` and not `:`: when a redirection fails on a special built-in such
  // as `:`, POSIX has the shell exit — dash and ksh do (measured; macOS's
  // bash 3.2 sh carries on). On a regular built-in it is only a status,
  // which `|| true` turns back into 0. The group's stderr goes nowhere, so a
  // marker that cannot be written says nothing either.
  return `{ true >"$${STEP_DIR_ENV}/${name}" || true; } 2>/dev/null`;
}

/** The marker file names: the step's index, and "end" after the last. */
export const END_MARK = "end";

/**
 * The checks `command` is made of, in order — or null when it is not
 * exactly their run texts joined by " && ". A text two checks share takes
 * the first name in the file; a shorter text that ends inside a longer one
 * never matches, since a check must end where a join or the command does.
 */
export function stepsOf(command: string, checks: CheckDef[]): CheckStep[] | null {
  if (command.length === 0 || checks.length === 0) return null;
  // Longest text first, so a check whose text begins another's cannot take its place.
  const byLength = [...checks].sort((a, b) => b.run.length - a.run.length || checks.indexOf(a) - checks.indexOf(b));
  const found: CheckStep[] = [];
  const walk = (at: number): boolean => {
    if (at === command.length) return found.length > 0;
    for (const check of byLength) {
      if (check.run.length === 0 || !command.startsWith(check.run, at)) continue;
      const end = at + check.run.length;
      if (end !== command.length && !command.startsWith(JOIN, end)) continue;
      found.push({ name: check.name, run: check.run, ...(check.results !== undefined ? { results: check.results } : {}) });
      if (walk(end === command.length ? end : end + JOIN.length)) return true;
      found.pop();
    }
    return false;
  };
  if (!walk(0)) return null;
  // The steps put back together must be the command, byte for byte: the
  // run is the approved text and nothing else.
  return found.map((s) => s.run).join(JOIN) === command ? found : null;
}

/** The command as it runs: each check behind its marker, the end marker last. */
export function markedCommand(steps: CheckStep[]): string {
  return [...steps.flatMap((s, i) => [marker(String(i)), s.run]), marker(END_MARK)].join(JOIN);
}

/** When the marker was written, in ms since the epoch; undefined when it never was. */
function markTime(dir: string, name: string): number | undefined {
  try {
    return fs.statSync(path.join(dir, name)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Each check's start, time and outcome, from the markers in `dir`. The
 * check the run ended in runs until `endedAtMs`. Undefined when the folder
 * is gone or holds no marker at all: then nothing can be said per check, and
 * nothing is guessed.
 */
export function readStepTimes(
  dir: string,
  steps: CheckStep[],
  run: { endedAtMs: number; exitCode: number | null; timedOut: boolean },
): StepTime[] | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const starts = steps.map((_, i) => markTime(dir, String(i)));
  if (starts[0] === undefined) return undefined;
  const end = markTime(dir, END_MARK);
  return steps.map((step, i) => {
    const start = starts[i];
    if (start === undefined) return { name: step.name, outcome: "not-started" as const };
    const next = i + 1 < steps.length ? starts[i + 1] : end;
    const startedAt = new Date(start).toISOString();
    if (next !== undefined) return { name: step.name, startedAt, durationMs: Math.max(0, Math.round(next - start)), outcome: "passed" as const };
    const outcome = run.timedOut ? "stopped" : run.exitCode === 0 ? "ended" : "failed";
    return { name: step.name, startedAt, durationMs: Math.max(0, Math.round(run.endedAtMs - start)), outcome };
  });
}

/** "0s", "14s", "1m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** HH:MM:SS in the machine's local time. */
export function clock(ms: number): string {
  const at = new Date(ms);
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** One line of every check's time: "prepare 14s · … · iphone 18m 20s (failed) · mac-build (not run)". */
export function stepTimesLine(times: StepTime[]): string {
  return times
    .map((t) => {
      if (t.outcome === "not-started") return `${t.name} (not run)`;
      const took = formatDuration(t.durationMs ?? 0);
      const note =
        t.outcome === "failed" ? " (failed)" : t.outcome === "stopped" ? " (stopped)" : t.outcome === "ended" ? " (the shell ended here)" : "";
      return `${t.name} ${took}${note}`;
    })
    .join(" · ");
}

/** Total time from the first check's start to the end of the last that ran. */
export function totalMs(times: StepTime[]): number {
  return times.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
}

/** "iphone (check 9 of 11) after 18m 20s" for the check the run ended in, or undefined. */
export function endedIn(times: StepTime[] | undefined): string | undefined {
  if (!times) return undefined;
  const at = times.findIndex((t) => t.outcome === "failed" || t.outcome === "stopped" || t.outcome === "ended");
  if (at < 0) return undefined;
  return `${times[at].name} (check ${at + 1} of ${times.length}) after ${formatDuration(times[at].durationMs ?? 0)}`;
}
