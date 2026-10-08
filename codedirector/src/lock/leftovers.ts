/**
 * Work left behind: changes an earlier lock made that are still uncommitted.
 *
 * A new lock takes the tree as it stands as "already there". If an earlier
 * lock's changes are still in that tree, they belong to no report any more,
 * and nothing said so: a failed lock's files sat in the tree under the next
 * lock for days, and verified work stayed uncommitted while new locks started
 * on top of it. This module finds them so the commands that start work can say
 * it. It only reads — it never changes the tree, and what it finds is a
 * warning, never a refusal.
 */

import { dirtyPaths, gitPrefix, toRootRelative, workTreeStatusPorcelain } from "../checkpoint";
import { latestRunRecord } from "../run/run";
import { listLocks } from "./store";
import type { LockStatus } from "./types";

export interface LeftBehind {
  lockId: string;
  status: LockStatus;
  /** Root-relative paths its latest run changed that are uncommitted now. */
  files: string[];
}

/** An abandoned lock is closed and a draft never ran: only these can hold work in the tree. */
const MAY_HOLD_WORK: LockStatus[] = ["failed", "incomplete", "active", "verified"];

/** The most files a warning names before it says how many more there are. */
const NAMED_FILES = 5;

/**
 * Those of `paths` (root-relative) that differ from HEAD or are untracked now.
 * Git names paths from the top of the work tree, and the repo may be a
 * subfolder of it, so they are translated the way a run's changes are.
 */
export function uncommittedAmong(rootDir: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const prefix = gitPrefix(rootDir);
  const dirty = new Set<string>();
  for (const gitPath of dirtyPaths(workTreeStatusPorcelain(rootDir))) {
    const rel = toRootRelative(prefix, gitPath);
    if (rel !== null) dirty.add(rel);
  }
  return paths.filter((p) => dirty.has(p));
}

/** What a lock's latest run changed, root-relative; nothing when it never ran. */
export function lastRunPaths(rootDir: string, lockId: string): string[] {
  return latestRunRecord(rootDir, lockId)?.record.changed.map((c) => c.path) ?? [];
}

/**
 * Earlier locks (newest first) whose latest run changed files that are still
 * uncommitted.
 *
 * A dirty file belongs to the newest lock whose latest run changed it, and
 * only that lock can be named for it: an older lock that changed the file
 * long ago (and was committed) is not to blame when a newer lock — even an
 * abandoned one, or the lock starting now — changed it again. So every lock
 * is read, whatever its status, before anyone is named.
 */
export function leftBehind(rootDir: string, exceptLockId: string): LeftBehind[] {
  const locks = listLocks(rootDir)
    .reverse()
    .map((lock) => ({ lock, changed: lastRunPaths(rootDir, lock.id) }));
  const owner = new Map<string, string>();
  for (const { lock, changed } of locks) for (const f of changed) if (!owner.has(f)) owner.set(f, lock.id);
  // One look at the tree for all of them.
  const dirty = new Set(uncommittedAmong(rootDir, locks.flatMap((l) => l.changed)));
  return locks
    .filter(({ lock }) => lock.id !== exceptLockId && MAY_HOLD_WORK.includes(lock.status))
    .map(({ lock, changed }) => ({
      lockId: lock.id,
      status: lock.status,
      files: changed.filter((f) => dirty.has(f) && owner.get(f) === lock.id),
    }))
    .filter((l) => l.files.length > 0);
}

function warningFor(l: LeftBehind): string {
  const more = l.files.length - NAMED_FILES;
  const files = l.files.slice(0, NAMED_FILES).join(", ") + (more > 0 ? `, +${more} more` : "");
  if (l.status === "verified") {
    return (
      `${l.lockId} is verified but not committed: ${files}. ` +
      `Commit it before new work, so this lock's report shows only its own changes.`
    );
  }
  return (
    `${l.lockId} (${l.status}) left changes in the tree: ${files}. ` +
    `This lock will count them as already there. ` +
    `Finish ${l.lockId}, or close it (cdir lock abandon ${l.lockId} --reason "…") and keep or drop its changes.`
  );
}

/** One line per earlier lock that left work behind — the warnings shown when new work starts. */
export function leftBehindWarnings(rootDir: string, exceptLockId: string): string[] {
  return leftBehind(rootDir, exceptLockId).map(warningFor);
}
