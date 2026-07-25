/**
 * Checkpoint / undo — the safety net that makes low-friction approval
 * defensible (blueprint §19): checkpoint before every execution, one
 * command to restore, no understanding required.
 *
 * Strategy: git tag `cdir/ckpt-<timestamp>` at HEAD, plus a byte snapshot of
 * dirty / untracked / skip-worktree files under .codedirector/ckpt-blobs/.
 * Undo resets --hard to the tagged ref, then restores that snapshot so a
 * checkpoint taken over a dirty tree actually comes back (including
 * skip-worktree files that `git reset --hard` would otherwise leave).
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
  /** Relative dir under .codedirector holding dirty-file bytes, when dirty. */
  blobDir?: string;
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

function unquotePath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1).replace(/\\"/g, '"');
  return p;
}

/** Paths on one porcelain line: rename SOURCE and target both included. */
export function porcelainLinePaths(line: string): string[] {
  if (!line.trim()) return [];
  let rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  if (arrow !== -1) {
    return [unquotePath(rest.slice(0, arrow)), unquotePath(rest.slice(arrow + 4))];
  }
  return [unquotePath(rest)];
}

/** Paths reported by `git status --porcelain` (rename source AND target). */
export function dirtyPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    out.push(...porcelainLinePaths(line));
  }
  return [...new Set(out)].sort();
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
      return !dirtyPaths(line).some(
        (p) => p.split("/").includes(".codedirector") || p === ".gitignore" || p.endsWith("/.gitignore"),
      );
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

interface BlobMeta {
  hidden: Array<{ path: string; flag: "S" | "h" }>;
  untracked: string[];
  files: string[];
}

function blobRoot(rootDir: string, id: string): string {
  return path.join(indexDir(rootDir), "ckpt-blobs", id);
}

/**
 * Absolute path for a git-root-relative path. rootDir may be a subdirectory
 * of the git work tree — translate via the prefix (walking up with ../ for
 * paths outside rootDir's subtree).
 */
function gitPathAbs(rootDir: string, gitPath: string): string {
  const prefix = gitPrefix(rootDir);
  if (!prefix) return path.join(rootDir, gitPath);
  const rel = toRootRelative(prefix, gitPath);
  if (rel !== null) return path.join(rootDir, rel);
  const up = prefix.split("/").filter(Boolean).map(() => "..").join("/");
  return path.resolve(rootDir, up, gitPath);
}

function writeCheckpointBlobs(rootDir: string, id: string): string {
  const dir = blobRoot(rootDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const untracked: string[] = [];
  const hidden: BlobMeta["hidden"] = [];

  const status = gitStatusPorcelain(rootDir);
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const st = line.slice(0, 2);
    for (const p of porcelainLinePaths(line)) {
      if (p.split("/").includes(".codedirector")) continue;
      const abs = gitPathAbs(rootDir, p);
      try {
        const data = fs.readFileSync(abs);
        const dest = path.join(dir, "files", p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
        files.push(p);
      } catch {
        /* vanished */
      }
      if (st === "??") untracked.push(p);
    }
  }

  try {
    const ls = git(rootDir, ["ls-files", "-v"]);
    for (const line of ls.split("\n")) {
      if (line.length < 3) continue;
      const flag = line[0];
      if (flag !== "S" && flag !== "h") continue;
      const p = line.slice(2);
      hidden.push({ path: p, flag });
      const abs = gitPathAbs(rootDir, p);
      try {
        const data = fs.readFileSync(abs);
        const dest = path.join(dir, "files", p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
        if (!files.includes(p)) files.push(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* not a git repo — shouldn't happen */
  }

  const meta: BlobMeta = { hidden, untracked: [...new Set(untracked)].sort(), files: [...new Set(files)].sort() };
  fs.writeFileSync(path.join(dir, "meta.json"), stableStringify(meta));
  return path.relative(indexDir(rootDir), dir).split(path.sep).join("/");
}

function restoreCheckpointBlobs(rootDir: string, id: string): void {
  const dir = blobRoot(rootDir, id);
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) return;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as BlobMeta;

  for (const h of meta.hidden) {
    try {
      git(rootDir, [
        "update-index",
        h.flag === "S" ? "--no-skip-worktree" : "--no-assume-unchanged",
        "--",
        h.path,
      ]);
    } catch {
      /* ignore */
    }
  }

  for (const p of meta.files) {
    const src = path.join(dir, "files", p);
    if (!fs.existsSync(src)) continue;
    const dest = gitPathAbs(rootDir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  for (const h of meta.hidden) {
    try {
      git(rootDir, [
        "update-index",
        h.flag === "S" ? "--skip-worktree" : "--assume-unchanged",
        "--",
        h.path,
      ]);
    } catch {
      /* ignore */
    }
  }
}

function clearSkipFlags(rootDir: string): void {
  try {
    const ls = git(rootDir, ["ls-files", "-v"]);
    for (const line of ls.split("\n")) {
      if (line.length < 3) continue;
      const flag = line[0];
      if (flag !== "S" && flag !== "h") continue;
      try {
        git(rootDir, [
          "update-index",
          flag === "S" ? "--no-skip-worktree" : "--no-assume-unchanged",
          "--",
          line.slice(2),
        ]);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Untracked files (git-root-relative) created after the checkpoint. */
function postCheckpointUntracked(rootDir: string, keep: Set<string>): string[] {
  const out: string[] = [];
  const status = gitStatusPorcelain(rootDir);
  for (const line of status.split("\n")) {
    if (!line.startsWith("??")) continue;
    for (const p of porcelainLinePaths(line)) {
      if (p.split("/").includes(".codedirector") || keep.has(p)) continue;
      out.push(p);
    }
  }
  return out.sort();
}

/** Delete the given git-root-relative paths; returns those actually removed. */
function deleteGitPaths(rootDir: string, paths: string[]): string[] {
  const removed: string[] = [];
  for (const p of paths) {
    try {
      fs.rmSync(gitPathAbs(rootDir, p), { recursive: true, force: true });
      removed.push(p);
    } catch {
      /* ignore */
    }
  }
  return removed;
}

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

  const dirty = status.trim() !== "";
  let blobDir: string | undefined;
  // Always snapshot hidden flags / dirty bytes so skip-worktree files restore.
  blobDir = writeCheckpointBlobs(rootDir, id);

  const ckpt: Checkpoint = {
    id,
    tag,
    ref,
    createdAt: new Date().toISOString(),
    dirty,
    statusHash: createHash("sha256").update(status, "utf8").digest("hex"),
    blobDir,
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
  /** Untracked files created after the checkpoint that undo DELETED. */
  deletedUntracked: string[];
  /** Untracked files still present after the undo (kept via --keep-untracked). */
  untrackedRemaining: string[];
}

export interface UndoOptions {
  force?: boolean;
  /**
   * Preserve untracked files created after the checkpoint. By default undo
   * deletes them (this changed from v0.1.0, which left them in place) so the
   * tree matches the checkpoint exactly; the deleted list is reported.
   */
  keepUntracked?: boolean;
}

/**
 * Restore the working tree to the latest checkpoint.
 *
 * Guard: if the checkpoint was taken over a DIRTY tree, refuse unless
 * `force` — restoring discards uncommitted work made since the checkpoint.
 * With --force, the dirty tree as of checkpoint time is restored from the
 * blob snapshot (not merely HEAD).
 *
 * NOTE (changed from v0.1.0): untracked files created AFTER the checkpoint
 * are deleted by default — pass `keepUntracked` (`--keep-untracked`) to
 * preserve them.
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
      `  then restore the dirty files captured at checkpoint time`,
      ``,
      `What will be LOST (changes made since the checkpoint):`,
    ];
    if (currentDirty.length === 0) {
      lines.push(`  (working tree looks clean; skip-worktree / committed-since-ckpt edits may still revert)`);
    } else {
      for (const p of currentDirty) lines.push(`  ${p}`);
    }
    lines.push(``, `Re-run with --force if that is what you want.`);
    throw new CheckpointError(lines.join("\n"));
  }

  clearSkipFlags(rootDir);
  git(rootDir, ["reset", "--hard", ckpt.ref]);
  let deletedUntracked: string[] = [];
  if (!opts.keepUntracked) {
    const keepUntracked = new Set<string>();
    const metaPath = path.join(blobRoot(rootDir, ckpt.id), "meta.json");
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as BlobMeta;
      for (const p of meta.untracked) keepUntracked.add(p);
    }
    // Enumerate and announce BEFORE deleting, so the notice names what is lost.
    const toDelete = postCheckpointUntracked(rootDir, keepUntracked);
    if (toDelete.length > 0) {
      process.stderr.write(
        `cdir undo: deleting ${toDelete.length} untracked file(s) created after the checkpoint:\n` +
          toDelete.map((p) => `  ${p}`).join("\n") +
          `\n(pass --keep-untracked to preserve them)\n`,
      );
      deletedUntracked = deleteGitPaths(rootDir, toDelete);
    }
  }
  restoreCheckpointBlobs(rootDir, ckpt.id);

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

  return {
    checkpoint: ckpt,
    forced: opts.force === true,
    lostFiles: currentDirty,
    deletedUntracked,
    untrackedRemaining: after,
  };
}
