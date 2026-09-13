/**
 * Lock persistence: .codedirector/locks/IL-<NNNN>-<slug>.yaml
 *
 * Locks are data, versioned in-repo (note: .codedirector is gitignored by
 * default; teams that want Locks in git can un-ignore the locks/ subdir).
 * Ids are sequential (IL-0001, IL-0002, ...) per repo.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { VibeCheck } from "./types";
import { lockFromYaml, lockToYaml } from "./yaml";
import { refreshSeal } from "./seal";

export function locksDir(rootDir: string): string {
  return path.join(rootDir, ".codedirector", "locks");
}

export function slugify(text: string, maxWords = 5): string {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2)
    .slice(0, maxWords);
  return words.length > 0 ? words.join("-") : "lock";
}

const LOCK_FILE_RE = /^(IL-\d{4,})-[a-z0-9-]+\.yaml$/;

interface LockFileEntry {
  id: string;
  file: string;
}

function scanLockFiles(rootDir: string): LockFileEntry[] {
  const dir = locksDir(rootDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => {
      const m = LOCK_FILE_RE.exec(f);
      return m ? { id: m[1], file: f } : null;
    })
    .filter((e): e is LockFileEntry => e !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Next sequential lock id: IL-0001, IL-0002, ... */
export function nextLockId(rootDir: string): string {
  const existing = scanLockFiles(rootDir);
  const max = existing.reduce((acc, e) => Math.max(acc, parseInt(e.id.slice(3), 10)), 0);
  return `IL-${String(max + 1).padStart(4, "0")}`;
}

export function lockPathFor(rootDir: string, id: string): string | null {
  const entry = scanLockFiles(rootDir).find((e) => e.id === id);
  return entry ? path.join(locksDir(rootDir), entry.file) : null;
}

function sealPath(rootDir: string, id: string): string {
  return path.join(rootDir, ".codedirector", "seals", `${id}.utterance`);
}

function readSealedUtterance(rootDir: string, id: string): string | null {
  const p = sealPath(rootDir, id);
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function writeSealedUtterance(rootDir: string, id: string, utterance: string): void {
  fs.mkdirSync(path.dirname(sealPath(rootDir, id)), { recursive: true });
  fs.writeFileSync(sealPath(rootDir, id), utterance, "utf8");
}

/** Load a Lock by id ("IL-0001"). Returns null when not found; throws LockParseError on bad YAML. */
export function loadLock(rootDir: string, id: string): VibeCheck | null {
  const p = lockPathFor(rootDir, id);
  if (!p) return null;
  const lock = lockFromYaml(fs.readFileSync(p, "utf8"));
  const sealed = readSealedUtterance(rootDir, id);
  if (sealed !== null && lock.status !== "draft") lock.utterance = sealed;
  return lock;
}

/** List all Locks, ordered by id. */
export function listLocks(rootDir: string): VibeCheck[] {
  return scanLockFiles(rootDir)
    .map((e) => loadLock(rootDir, e.id))
    .filter((l): l is VibeCheck => l !== null);
}

/**
 * Save a Lock. The filename is derived from id + slug of the utterance;
 * if the slug changed (utterance is immutable, so it should not), the old
 * file is removed. Returns the written path.
 */
export function saveLock(rootDir: string, lock: VibeCheck): string {
  fs.mkdirSync(locksDir(rootDir), { recursive: true });
  const sealed = readSealedUtterance(rootDir, lock.id);
  if (lock.status !== "draft") {
    if (sealed !== null) lock.utterance = sealed;
    else writeSealedUtterance(rootDir, lock.id, lock.utterance);
  }
  const fileName = `${lock.id}-${slugify(lock.utterance)}.yaml`;
  const target = path.join(locksDir(rootDir), fileName);
  const prev = lockPathFor(rootDir, lock.id);
  fs.writeFileSync(target, lockToYaml(lock), "utf8");
  if (prev && prev !== target) fs.rmSync(prev);
  // Internal writes (activation, run status transitions) re-pin the seal so
  // the approved contract stays valid; status is outside the sealed hash.
  refreshSeal(rootDir, lock);
  return target;
}
