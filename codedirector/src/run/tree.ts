/**
 * Working-tree snapshot / restore. Used so KEEP probes (baseline capture,
 * tests, verifyCommand, output-unchanged) cannot leave mutations behind,
 * and so classification can see skip-worktree / assume-unchanged files
 * that `git status` hides.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gitPrefix, gitStatusPorcelain, toRootRelative } from "../checkpoint";

export interface HiddenFile {
  /** git-root-relative path */
  path: string;
  /** S = skip-worktree, h = assume-unchanged */
  flag: "S" | "h";
  hash: string;
}

export interface WorkTreeSnapshot {
  /** git-root-relative path -> raw bytes (dirty + untracked + hidden). Buffer, so binary files round-trip byte-identical. */
  contents: Record<string, Buffer>;
  /** git-root-relative path -> sha256, including tracked-clean files we may restore via checkout. */
  hashes: Record<string, string>;
  hidden: HiddenFile[];
  untracked: string[];
}

function git(rootDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}

export function sha256Bytes(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1).replace(/\\"/g, '"');
  return p;
}

/** Every path on a porcelain line, including rename SOURCE and target. */
export function porcelainAllPaths(line: string): string[] {
  if (!line.trim()) return [];
  let rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  if (arrow !== -1) {
    return [unquote(rest.slice(0, arrow)), unquote(rest.slice(arrow + 4))];
  }
  return [unquote(rest)];
}

export function listHidden(rootDir: string): HiddenFile[] {
  let raw = "";
  try {
    raw = git(rootDir, ["ls-files", "-v"]);
  } catch {
    return [];
  }
  const out: HiddenFile[] = [];
  for (const line of raw.split("\n")) {
    if (line.length < 3) continue;
    const flag = line[0];
    if (flag !== "S" && flag !== "h") continue;
    const p = line.slice(2);
    const abs = path.join(rootDir, gitToAbsRel(rootDir, p));
    let hash = "";
    try {
      hash = sha256Bytes(fs.readFileSync(abs));
    } catch {
      hash = "";
    }
    out.push({ path: p, flag, hash });
  }
  return out;
}

/** Translate a git-root-relative path into a path relative to rootDir (may start with ../). */
export function gitToAbsRel(rootDir: string, gitPath: string): string {
  const prefix = gitPrefix(rootDir);
  if (!prefix) return gitPath;
  const rel = toRootRelative(prefix, gitPath);
  if (rel !== null) return rel;
  // outside rootDir: walk up with ../
  const up = prefix.split("/").filter(Boolean).map(() => "..").join("/");
  return up ? `${up}/${gitPath}` : gitPath;
}

export function readGitPath(rootDir: string, gitPath: string): Buffer | null {
  const rel = gitToAbsRel(rootDir, gitPath);
  const abs = path.join(rootDir, rel);
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

export function snapshotWorkTree(rootDir: string): WorkTreeSnapshot {
  const contents: Record<string, Buffer> = {};
  const hashes: Record<string, string> = {};
  const untracked: string[] = [];

  let tracked: string[] = [];
  try {
    tracked = git(rootDir, ["ls-files", "-z"]).split("\0").filter(Boolean);
  } catch {
    tracked = [];
  }
  for (const p of tracked) {
    const text = readGitPath(rootDir, p);
    if (text === null) continue;
    hashes[p] = sha256Bytes(text);
  }

  const porcelain = gitStatusPorcelain(rootDir);
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    for (const p of porcelainAllPaths(line)) {
      if (p.split("/").includes(".codedirector")) continue;
      const text = readGitPath(rootDir, p);
      if (text !== null) {
        contents[p] = text;
        hashes[p] = sha256Bytes(text);
      }
      if (status === "??") untracked.push(p);
    }
  }

  const hidden = listHidden(rootDir);
  for (const h of hidden) {
    const text = readGitPath(rootDir, h.path);
    if (text !== null) {
      contents[h.path] = text;
      hashes[h.path] = sha256Bytes(text);
    }
  }

  return { contents, hashes, hidden, untracked: [...new Set(untracked)].sort() };
}

function isToolPath(gitPath: string): boolean {
  return gitPath.split("/").includes(".codedirector") || gitPath === ".gitignore";
}

/** Untracked files (git-root-relative), excluding tool dirs. */
export function listUntracked(rootDir: string): string[] {
  const por = gitStatusPorcelain(rootDir);
  const set = new Set<string>();
  for (const line of por.split("\n")) {
    if (line.startsWith("??")) {
      for (const p of porcelainAllPaths(line)) set.add(p);
    }
  }
  return [...set].filter((p) => !isToolPath(p)).sort();
}

const CHECKOUT_BATCH = 200;

export function restoreWorkTree(rootDir: string, snap: WorkTreeSnapshot): void {
  // Drop skip-worktree so checkout/write can land (and so a file the probe
  // hid mid-run becomes visible to porcelain again).
  for (const h of listHidden(rootDir)) {
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

  // Delete untracked files created after the snapshot.
  for (const p of listUntracked(rootDir)) {
    if (snap.untracked.includes(p) || isToolPath(p)) continue;
    const abs = path.join(rootDir, gitToAbsRel(rootDir, p));
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* ignore */
    }
  }

  // Restore snapshotted contents (raw bytes — binary-safe).
  for (const [p, data] of Object.entries(snap.contents)) {
    const abs = path.join(rootDir, gitToAbsRel(rootDir, p));
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
    } catch {
      /* ignore */
    }
  }

  // Tracked files that were clean at snap and whose bytes moved: restore from
  // HEAD. Candidates come from porcelain (flags already dropped above), then
  // are hash-verified against the snapshot — clean files cost zero git spawns.
  const stale: string[] = [];
  const candidates = new Set<string>();
  for (const line of gitStatusPorcelain(rootDir).split("\n")) {
    if (!line.trim()) continue;
    for (const p of porcelainAllPaths(line)) candidates.add(p);
  }
  for (const p of candidates) {
    if (!(p in snap.hashes) || p in snap.contents) continue;
    const now = readGitPath(rootDir, p);
    if (now === null || sha256Bytes(now) !== snap.hashes[p]) stale.push(p);
  }
  for (let i = 0; i < stale.length; i += CHECKOUT_BATCH) {
    try {
      git(rootDir, ["checkout", "HEAD", "--", ...stale.slice(i, i + CHECKOUT_BATCH)]);
    } catch {
      /* ignore */
    }
  }

  // Re-apply hidden flags.
  for (const h of snap.hidden) {
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

export function runIsolated<T>(rootDir: string, fn: () => T): T {
  const snap = snapshotWorkTree(rootDir);
  try {
    return fn();
  } finally {
    restoreWorkTree(rootDir, snap);
  }
}

export function currentHead(rootDir: string): string | null {
  try {
    return git(rootDir, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

export function nameStatusSince(rootDir: string, fromRev: string): Array<{ status: string; paths: string[] }> {
  let raw = "";
  try {
    raw = git(rootDir, ["diff", "--name-status", "-M", fromRev]);
  } catch {
    return [];
  }
  const out: Array<{ status: string; paths: string[] }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0][0]; // M, A, D, R, C, T
    const paths = parts.slice(1).filter(Boolean);
    out.push({ status, paths });
  }
  return out;
}

export function nameStatusRange(rootDir: string, fromRev: string, toRev: string): Array<{ status: string; paths: string[] }> {
  let raw = "";
  try {
    raw = git(rootDir, ["diff", "--name-status", "-M", `${fromRev}..${toRev}`]);
  } catch {
    return [];
  }
  const out: Array<{ status: string; paths: string[] }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0][0];
    const paths = parts.slice(1).filter(Boolean);
    out.push({ status, paths });
  }
  return out;
}
