/**
 * Checkpoint / undo — the safety net that makes low-friction approval
 * defensible (blueprint §19): checkpoint before every execution, one
 * command to restore, no understanding required.
 *
 * Strategy (stash-free): a lightweight git tag `cdir/ckpt-<timestamp>` at
 * HEAD, plus a hash of `git status --porcelain` recording whether the tree
 * was dirty. Undo resets --hard to the tagged ref; when the checkpoint was
 * taken over a dirty tree, undo refuses without --force and says precisely
 * what will be lost. Every undo is logged.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isGitRepo } from "../core/git";
import { indexDir, stableStringify } from "../core/store";

export interface Checkpoint {
  /** "ckpt-<yyyymmddThhmmssmmm>" */
  id: string;
  /** Git tag: "cdir/ckpt-<...>" */
  tag: string;
  /** HEAD commit sha at checkpoint time. */
  ref: string;
  createdAt: string;
  /** True when the working tree had uncommitted changes at checkpoint time. */
  dirty: boolean;
  /** sha256 of `git status --porcelain` output at checkpoint time. */
  statusHash: string;
}

export interface UndoRecord {
  at: string;
  checkpointId: string;
  ref: string;
  forced: boolean;
  /** Dirty paths discarded by the reset (empty when the tree was clean). */
  lostFiles: string[];
}

interface CheckpointStore {
  checkpoints: Checkpoint[];
  undos: UndoRecord[];
}

export function checkpointsPath(rootDir: string): string {
  return path.join(indexDir(rootDir), "checkpoints.json");
}

function loadStore(rootDir: string): CheckpointStore {
  const p = checkpointsPath(rootDir);
  if (!fs.existsSync(p)) return { checkpoints: [], undos: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as CheckpointStore;
    return { checkpoints: data.checkpoints ?? [], undos: data.undos ?? [] };
  } catch {
    return { checkpoints: [], undos: [] };
  }
}

function saveStore(rootDir: string, store: CheckpointStore): void {
  fs.mkdirSync(indexDir(rootDir), { recursive: true });
  fs.writeFileSync(checkpointsPath(rootDir), stableStringify(store), "utf8");
}

function git(rootDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}

/** Paths reported by `git status --porcelain` (rename targets resolved). */
export function dirtyPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4);
    // quoted paths (special chars) come wrapped in double quotes
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    out.push(p);
  }
  return out.sort();
}

export function gitStatusPorcelain(rootDir: string): string {
  return git(rootDir, ["status", "--porcelain"]);
}

/**
 * `git status --porcelain` with Code Director's own state directory
 * (.codedirector/) filtered out — locks, baselines, and run records are
 * tool state, not user work, and must not count as "dirty".
 */
export function workTreeStatusPorcelain(rootDir: string): string {
  return gitStatusPorcelain(rootDir)
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      return !dirtyPaths(line).some((p) => p.split("/").includes(".codedirector"));
    })
    .join("\n");
}

/**
 * Prefix of rootDir within its git work tree ("" when rootDir IS the git
 * root). Git reports paths relative to the work-tree root; when rootDir is
 * a subdirectory, callers must translate.
 */
export function gitPrefix(rootDir: string): string {
  try {
    return git(rootDir, ["rev-parse", "--show-prefix"]).trim();
  } catch {
    return "";
  }
}

/**
 * Translate a git-root-relative path to rootDir-relative. Returns null when
 * the path lies outside rootDir's subtree.
 */
export function toRootRelative(prefix: string, gitPath: string): string | null {
  if (!prefix) return gitPath;
  if (gitPath.startsWith(prefix)) return gitPath.slice(prefix.length);
  return null;
}

function timestampId(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`
  );
}

export class CheckpointError extends Error {}

/** Create a checkpoint at HEAD. Requires a git repo with at least one commit. */
export function createCheckpoint(rootDir: string): Checkpoint {
  if (!isGitRepo(rootDir)) {
    throw new CheckpointError("not a git repository — checkpoints need git (run `git init` first)");
  }
  let ref: string;
  try {
    ref = git(rootDir, ["rev-parse", "HEAD"]).trim();
  } catch {
    throw new CheckpointError("no commits yet — make an initial commit before checkpointing");
  }
  const status = workTreeStatusPorcelain(rootDir);
  const id = `ckpt-${timestampId()}`;
  const tag = `cdir/${id}`;
  git(rootDir, ["tag", tag, ref]);

  const ckpt: Checkpoint = {
    id,
    tag,
    ref,
    createdAt: new Date().toISOString(),
    dirty: status.trim() !== "",
    statusHash: createHash("sha256").update(status, "utf8").digest("hex"),
  };
  const store = loadStore(rootDir);
  store.checkpoints.push(ckpt);
  saveStore(rootDir, store);
  return ckpt;
}

export function latestCheckpoint(rootDir: string): Checkpoint | null {
  const store = loadStore(rootDir);
  return store.checkpoints.length > 0 ? store.checkpoints[store.checkpoints.length - 1] : null;
}

export interface UndoResult {
  checkpoint: Checkpoint;
  forced: boolean;
  lostFiles: string[];
  /** Untracked files still present after the reset (reset --hard does not remove them). */
  untrackedRemaining: string[];
}

export interface UndoOptions {
  force?: boolean;
}

/**
 * Restore the working tree to the latest checkpoint.
 *
 * Guard: if the checkpoint was taken over a DIRTY tree, refuse unless
 * `force` — a reset would silently discard uncommitted work that existed
 * before the checkpoint (and any made since). The refusal says precisely
 * what will be lost.
 */
export function undo(rootDir: string, opts: UndoOptions = {}): UndoResult {
  if (!isGitRepo(rootDir)) {
    throw new CheckpointError("not a git repository — nothing to undo");
  }
  const ckpt = latestCheckpoint(rootDir);
  if (!ckpt) {
    throw new CheckpointError("no checkpoint recorded — nothing to undo");
  }

  const currentStatus = gitStatusPorcelain(rootDir);
  const currentDirty = dirtyPaths(currentStatus).filter((p) => !p.split("/").includes(".codedirector"));

  if (ckpt.dirty && !opts.force) {
    const lines = [
      `refusing to undo: checkpoint ${ckpt.id} was taken over a dirty working tree.`,
      ``,
      `What ` + "`cdir undo --force`" + ` will do:`,
      `  git reset --hard ${ckpt.ref.slice(0, 12)}  (${ckpt.tag})`,
      ``,
      `What will be LOST (uncommitted changes, gone permanently):`,
    ];
    if (currentDirty.length === 0) {
      lines.push(`  (the tree is clean right now, but the pre-checkpoint uncommitted`);
      lines.push(`   state was never captured — reset cannot bring it back either)`);
    } else {
      for (const p of currentDirty) lines.push(`  ${p}`);
    }
    lines.push(``, `Re-run with --force if that is what you want.`);
    throw new CheckpointError(lines.join("\n"));
  }

  git(rootDir, ["reset", "--hard", ckpt.ref]);

  const after = dirtyPaths(gitStatusPorcelain(rootDir)).filter((p) => !p.split("/").includes(".codedirector"));
  const record: UndoRecord = {
    at: new Date().toISOString(),
    checkpointId: ckpt.id,
    ref: ckpt.ref,
    forced: opts.force === true,
    lostFiles: currentDirty,
  };
  const store = loadStore(rootDir);
  store.undos.push(record);
  saveStore(rootDir, store);

  return { checkpoint: ckpt, forced: opts.force === true, lostFiles: currentDirty, untrackedRemaining: after };
}
