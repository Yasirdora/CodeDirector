/**
 * Lock sealing: approving a Lock (`lock activate`) pins a canonical hash of
 * its content — minus the status field — to .codedirector/seals.json.
 * `cdir run` / `cdir verify` recompute the hash of the on-disk Lock before
 * executing; a mismatch means the contract was edited after approval, and
 * the run is refused until the user re-approves (`lock check` +
 * `lock activate`, which re-seals).
 *
 * Status transitions (active → verified/failed) never trip the seal:
 * `status` is excluded from the hash, and saveLock refreshes the entry
 * after every internal write.
 *
 * This is a guardrail against convenient shortcuts, not adversarial crypto:
 * the same file-edit tools could rewrite seals.json too. The point is that
 * quietly passing yourself stops being a one-line edit of the contract and
 * becomes a second, obviously intentional tamper step.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { stableStringify } from "../core/store";
import { VibeCheck } from "./types";

function sealsPath(rootDir: string): string {
  return path.join(rootDir, ".codedirector", "seals.json");
}

export function readSeals(rootDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(sealsPath(rootDir), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSeals(rootDir: string, seals: Record<string, string>): void {
  fs.mkdirSync(path.dirname(sealsPath(rootDir)), { recursive: true });
  fs.writeFileSync(sealsPath(rootDir), stableStringify(seals), "utf8");
}

/** Canonical content hash: everything except `status` (internal transitions must not trip the seal). */
export function canonicalLockHash(lock: VibeCheck): string {
  const rest: Record<string, unknown> = { ...lock };
  delete rest.status;
  return createHash("sha256").update(stableStringify(rest), "utf8").digest("hex");
}

/** Pin the seal for a Lock — called at activation, i.e. the user's approval. */
export function sealLock(rootDir: string, lock: VibeCheck): void {
  const seals = readSeals(rootDir);
  seals[lock.id] = canonicalLockHash(lock);
  writeSeals(rootDir, seals);
}

/** Refresh an existing seal after an internal write (saveLock); no-op when the Lock was never sealed. */
export function refreshSeal(rootDir: string, lock: VibeCheck): void {
  const seals = readSeals(rootDir);
  if (seals[lock.id] === undefined) return;
  seals[lock.id] = canonicalLockHash(lock);
  writeSeals(rootDir, seals);
}

/**
 * The re-approval refusal, or null when the Lock may run. Only ACTIVE Locks
 * are gated: drafts never run anyway, and verified/failed Locks are history.
 *
 * Fail CLOSED on a missing seal: an active Lock with no seal entry was
 * activated outside the official path (a direct hand-edit of status, which
 * creates no seal) — that is exactly the bypass sealing exists to prevent.
 * Locks sealed before this rule shipped are unaffected: their entries exist.
 */
export function sealViolation(rootDir: string, lock: VibeCheck): string | null {
  if (lock.status !== "active") return null;
  const seal = readSeals(rootDir)[lock.id];
  if (seal === undefined) {
    return (
      `lock ${lock.id} is active but has no approval seal — it was activated outside the ` +
      `official path, so the user's approval was never pinned. Approve it properly: ` +
      `\`cdir lock check ${lock.id} && cdir lock activate ${lock.id}\`.`
    );
  }
  if (canonicalLockHash(lock) === seal) return null;
  return (
    `lock ${lock.id} was modified after approval (seal mismatch). ` +
    `Scope changes need the user's re-approval: review the lock, then ` +
    `\`cdir lock check ${lock.id} && cdir lock activate ${lock.id}\` to re-seal.`
  );
}
