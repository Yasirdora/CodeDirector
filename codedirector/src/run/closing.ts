/**
 * Where a lock's answer over the live tree ends.
 *
 * A lock answers for the tree from its task baseline until the next lock
 * starts. "Starts" is a fact in the store, not a guess: another lock's task
 * baseline, captured after this lock's last attempt finished. From then on
 * the live tree holds that lock's work too, and judging this lock against it
 * blames it for changes it never made — a sibling's sealed files read as
 * OUT-OF-BUDGET, a later change as a broken KEEP — and wrote FAILED onto a
 * lock that was verified when it ran.
 *
 * A lock whose own task baseline is the newer one is open again: `cdir lock
 * rebase` is the human pointing it at the present tree. The earliest
 * closing lock is the one named, because that is where this lock's
 * answerability ended.
 *
 * Not covered, and said in the README: two locks running at once (each
 * still sees the other's files), and an edit made between this lock's last
 * attempt and the next lock's start (no report judges it once that lock
 * exists).
 *
 * Both the report (which shows a closed lock as recorded) and the run (which
 * refuses to start one) ask this question; it lives beside the run types so
 * neither has to import the other.
 */

import * as fs from "node:fs";
import { Baseline, baselinesDir, loadTaskBaseline, taskBaselineFileName } from "./baseline";

/** The lock that closed another, and when it started. */
export interface ClosingLock {
  lockId: string;
  /** When its task baseline was captured (ISO 8601). */
  capturedAt: string;
}

/**
 * The lock that closed `lockId`, or null while it is still open.
 *
 * See the module comment for the rule. `lastAttempt` may be the recorded
 * attempt, or `{ finishedAt: taskBaseline.capturedAt }` before a first
 * attempt: either way, answerability began no earlier than the task
 * baseline, so the later of the two is the boundary.
 */
export function closingLock(
  rootDir: string,
  lockId: string,
  lastAttempt: { finishedAt: string },
  taskBaseline: Baseline | null,
): ClosingLock | null {
  const since = Math.max(
    Date.parse(lastAttempt.finishedAt),
    taskBaseline ? Date.parse(taskBaseline.capturedAt) : Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(since)) return null; // an unreadable date closes nothing
  const dir = baselinesDir(rootDir);
  if (!fs.existsSync(dir)) return null;

  const suffix = taskBaselineFileName("");
  let closing: ClosingLock | null = null;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(suffix)) continue;
    const other = file.slice(0, -suffix.length);
    if (other === lockId) continue;
    const capturedAt = loadTaskBaseline(rootDir, other)?.capturedAt;
    if (capturedAt === undefined) continue;
    const at = Date.parse(capturedAt);
    if (!(at > since)) continue;
    if (closing === null || at < Date.parse(closing.capturedAt)) closing = { lockId: other, capturedAt };
  }
  return closing;
}

/**
 * Why an explicit re-verify is refused on a closed lock — one wording,
 * thrown by the report builder for `cdir verify`, `cdir report --reverify`
 * and the MCP `report` tool alike.
 *
 * `lastAttempt` is null when the record cannot say which attempt it was (no
 * attempt id): the parenthesis is then left out rather than guessed.
 */
export function closedReverifyRefusal(
  lockId: string,
  closedBy: ClosingLock,
  lastAttempt: { attemptId: string; verdict: string } | null,
): string {
  const recorded = lastAttempt === null ? "" : ` (${lastAttempt.attemptId}, ${lastAttempt.verdict})`;
  return (
    `${lockId} cannot be checked again here: ${closedBy.lockId} started at ${closedBy.capturedAt}, ` +
    `after ${lockId}'s last attempt${recorded}. The tree holds ${closedBy.lockId}'s work now, so nothing was run ` +
    `and ${lockId}'s status is unchanged. \`cdir report ${lockId}\` shows that attempt as recorded. ` +
    `To check this work again: take its changes out of the tree, run \`cdir lock rebase ${lockId} --accept-current\`, ` +
    `then \`cdir run ${lockId} -- <command>\`; or abandon it and carry its contract to a new lock.`
  );
}

/**
 * Why a new attempt is refused on a closed lock — the run's counterpart of
 * closedReverifyRefusal, with the same remedy. `hadAttempt` picks the closing
 * fact: the recorded attempt, or (before a first attempt) the capture of the
 * task baseline. `taskBaselineCapturedAt` is null only when the baseline is
 * missing, and the capture time is then left out rather than guessed.
 */
export function closedRunRefusal(
  lockId: string,
  closedBy: ClosingLock,
  taskBaselineCapturedAt: string | null,
  hadAttempt: boolean,
): string {
  const ended = hadAttempt ? `${lockId}'s last attempt` : `${lockId}'s task baseline was captured`;
  const judged =
    taskBaselineCapturedAt === null
      ? `A new attempt would be judged against ${lockId}'s task baseline`
      : `A new attempt is judged against ${lockId}'s task baseline (captured ${taskBaselineCapturedAt})`;
  return (
    `${lockId} cannot run again as it stands: ${closedBy.lockId} started at ${closedBy.capturedAt}, after ${ended}. ` +
    `${judged}, so ${closedBy.lockId}'s changes would be counted as ${lockId}'s. ` +
    `To do this work again: take its changes out of the tree, run \`cdir lock rebase ${lockId} --accept-current\`, ` +
    `then run it; or abandon it and carry its contract to a new lock.`
  );
}
