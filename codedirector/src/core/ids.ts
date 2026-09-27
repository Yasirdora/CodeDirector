/**
 * Record identity.
 *
 * Every persisted artifact — a baseline, a run record, a lock id
 * reservation, and in later stages an attempt — is named with an id that
 * cannot collide with another, even between two sessions that start in the
 * same millisecond. Before this module, names were truncated to the second
 * (two captures inside one second overwrote each other), and lock ids were
 * allocated by reading the maximum and writing the next (two parallel
 * drafts could pick the same id).
 *
 * The id format is `<YYYYMMDD>-<HHMMSS>-<mmm>-<pid36><seq36>-<peer>`:
 * sortable in capture order, so "latest by name" stays meaningful, with a
 * per-process sequence and a per-process random tail making same-ms
 * collisions across processes vanishingly unlikely.
 *
 * writeFileAtomic gives every state file the same all-or-nothing property
 * for readers: a temp file in the destination directory, then rename. A
 * reader sees the old file or the new one, never a partial write; a crash
 * leaves a stray temp file, never a corrupt record.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** Per-process entropy: two processes cannot mint the same id. */
const PEER = randomBytes(2).toString("hex");
let seq = 0;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * A sortable, collision-proof record id for the given instant (default:
 * now). Same-millisecond calls differ by sequence; the same millisecond in
 * two processes differs by pid, sequence, and PEER.
 */
export function newRecordId(at: Date = new Date()): string {
  const ts =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}` +
    `-${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}` +
    `-${pad(at.getUTCMilliseconds(), 3)}`;
  return `${ts}-${process.pid.toString(36)}${(seq++).toString(36)}-${PEER}`;
}

/**
 * Write a file all-or-nothing: temp file in the destination directory, then
 * rename over the target. Rename within one directory is atomic on POSIX;
 * a failed write leaves the destination untouched.
 */
export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid.toString(36)}-${PEER}`,
  );
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the rename error is the one worth surfacing */
    }
    throw e;
  }
}
