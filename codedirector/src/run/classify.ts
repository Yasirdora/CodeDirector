/**
 * Change classification: every file the command touched is classified
 * against the Lock — denied, in-budget, or out-of-budget.
 *
 * Deny wins over budget. Classification is a delta against the pre-run
 * baseline (HEAD, dirty hashes, skip-worktree), not "git status vs current
 * HEAD" — otherwise `git commit`, `git mv` into budget, and skip-worktree
 * hide deny edits.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { VibeCheck } from "../lock/types";
import { matchPath } from "../lock/glob";
import { gitPrefix, gitStatusPorcelain, porcelainLinePaths, toRootRelative } from "../checkpoint";
import { Baseline } from "./baseline";
import {
  currentHead,
  gitToAbsRel,
  listHidden,
  nameStatusRange,
  nameStatusSince,
  porcelainAllPaths,
  sha256Bytes,
} from "./tree";

export type ChangeClass = "denied" | "out-of-budget" | "in-budget";

export interface ClassifiedChange {
  path: string;
  /** porcelain status letters, e.g. "M", "??", "A", "R" */
  status: string;
  class: ChangeClass;
  /** The deny pattern that matched, when class is "denied". */
  matchedDeny?: string;
}

function displayPath(rootDir: string, gitPath: string): string {
  const prefix = gitPrefix(rootDir);
  const rel = toRootRelative(prefix, gitPath);
  if (rel !== null) return rel;
  return gitToAbsRel(rootDir, gitPath);
}

function hashGitPath(rootDir: string, gitPath: string): string | null {
  const abs = path.join(rootDir, gitToAbsRel(rootDir, gitPath));
  try {
    return sha256Bytes(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

/**
 * Files the run actually touched, as paths relative to rootDir (or ../
 * for writes outside --root). When `baseline` is passed, pre-existing dirt
 * whose bytes did not change is excluded; commits since baseline.head and
 * skip-worktree edits are included.
 */
export function changedFiles(
  rootDir: string,
  baseline?: Baseline | null,
): Array<{ path: string; status: string }> {
  if (!baseline?.head) {
    return changedFilesVsHead(rootDir);
  }
  return changedFilesSinceBaseline(rootDir, baseline);
}

function changedFilesVsHead(rootDir: string): Array<{ path: string; status: string }> {
  const porcelain = gitStatusPorcelain(rootDir);
  const out: Array<{ path: string; status: string }> = [];
  const seen = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    for (const p of porcelainLinePaths(line)) {
      if (p.split("/").includes(".codedirector") || p === ".gitignore") continue;
      const rel = displayPath(rootDir, p);
      if (seen.has(rel)) continue;
      seen.add(rel);
      out.push({ path: rel, status });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function changedFilesSinceBaseline(
  rootDir: string,
  baseline: Baseline,
): Array<{ path: string; status: string }> {
  const hits = new Map<string, string>(); // display path -> status
  const add = (gitPath: string, status: string) => {
    if (gitPath.split("/").includes(".codedirector") || gitPath === ".gitignore" || gitPath.endsWith("/.gitignore"))
      return;
    const rel = displayPath(rootDir, gitPath);
    if (!hits.has(rel)) hits.set(rel, status);
  };

  const headNow = currentHead(rootDir);

  // 1. Commits since baseline HEAD (catches `git add && git commit` hide).
  if (baseline.head && headNow && headNow !== baseline.head) {
    for (const row of nameStatusRange(rootDir, baseline.head, headNow)) {
      for (const p of row.paths) add(p, row.status);
    }
  }

  // 2. Uncommitted delta vs current HEAD, including rename sources.
  const porcelain = gitStatusPorcelain(rootDir);
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    for (const p of porcelainAllPaths(line)) add(p, status);
  }

  // 3. Working tree vs baseline HEAD (covers commits + uncommitted together
  //    when HEAD moved, and uncommitted-only when it didn't).
  if (baseline.head) {
    for (const row of nameStatusSince(rootDir, baseline.head)) {
      for (const p of row.paths) add(p, row.status);
    }
  }

  // 4. skip-worktree / assume-unchanged whose bytes moved.
  const hiddenNow = listHidden(rootDir);
  const hiddenThen = new Map((baseline.hidden ?? []).map((h) => [h.path, h.hash]));
  for (const h of hiddenNow) {
    const before = hiddenThen.get(h.path);
    if (before !== undefined && before !== h.hash) add(h.path, "H");
    if (before === undefined && h.hash) add(h.path, "H");
  }
  for (const [p, hash] of hiddenThen) {
    if (!hiddenNow.some((h) => h.path === p)) {
      const now = hashGitPath(rootDir, p);
      if (now !== hash) add(p, "H");
    }
  }

  // Drop pre-existing dirt whose bytes are unchanged AND that was not committed.
  const pre = baseline.workTreeHashes ?? {};
  const committed = new Set<string>();
  if (baseline.head && headNow && headNow !== baseline.head) {
    for (const row of nameStatusRange(rootDir, baseline.head, headNow)) {
      for (const p of row.paths) committed.add(displayPath(rootDir, p));
    }
  }

  const out: Array<{ path: string; status: string }> = [];
  for (const [rel, status] of hits) {
    // Map display path back to a git path for hash lookup: try rel as git path,
    // and also prefix+rel.
    const prefix = gitPrefix(rootDir);
    const gitPath = prefix && !rel.startsWith("..") ? prefix + rel : rel.replace(/^\.\.\//, "");
    const preHash = pre[gitPath] ?? pre[rel];
    if (preHash !== undefined && !committed.has(rel)) {
      const now = hashGitPath(rootDir, gitPath) ?? hashGitPath(rootDir, rel);
      if (now === preHash) continue; // pre-existing dirt, untouched
    }
    out.push({ path: rel, status });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Classify a single path against the Lock. */
export function classifyPath(lock: VibeCheck, relPath: string): ClassifiedChange {
  const normalized = relPath.replace(/\\/g, "/");
  for (const d of lock.deny) {
    if (matchPath(d, normalized)) {
      return { path: relPath, status: "", class: "denied", matchedDeny: d };
    }
  }
  const inBudget = lock.budget.files.some((f) => matchPath(f, normalized));
  return { path: relPath, status: "", class: inBudget ? "in-budget" : "out-of-budget" };
}

/** Classify all run-touched files against the Lock. */
export function classifyChanges(rootDir: string, lock: VibeCheck, baseline?: Baseline | null): ClassifiedChange[] {
  return changedFiles(rootDir, baseline).map((c) => ({ ...classifyPath(lock, c.path), status: c.status }));
}

/**
 * Lines changed by the run, plus the full line count of newly untracked
 * files. Tracked files are measured vs the baseline HEAD, but a file the
 * run never touched (current bytes == baseline bytes) is excluded —
 * pre-existing dirt must not count against the budget; classifyChanges
 * already excludes it and line counting follows the same rule. A touched
 * file counts its full delta vs the baseline HEAD, so a file with both
 * pre-existing and run changes can overcount (tripwire, not proof).
 */
export function changedLineCount(rootDir: string, untrackedPaths: string[], baseline?: Baseline | null): number {
  let total = 0;
  const prefix = gitPrefix(rootDir);
  const from = baseline?.head ?? "HEAD";
  const pre = baseline?.workTreeHashes ?? {};
  const headNow = currentHead(rootDir);
  const committed = new Set<string>();
  if (baseline?.head && headNow && headNow !== baseline.head) {
    for (const row of nameStatusRange(rootDir, baseline.head, headNow)) {
      for (const p of row.paths) committed.add(displayPath(rootDir, p));
    }
  }
  try {
    const numstat = execFileSync("git", ["diff", "--numstat", from], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    for (const line of numstat.split("\n")) {
      const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
      if (!m) continue;
      const rel = toRootRelative(prefix, m[3]);
      const preHash = pre[m[3]] ?? (rel !== null ? pre[rel] : undefined);
      if (preHash !== undefined && (rel === null || !committed.has(rel))) {
        const now = hashGitPath(rootDir, m[3]) ?? (rel !== null ? hashGitPath(rootDir, rel) : null);
        if (now === preHash) continue; // pre-existing dirt, untouched by the run
      }
      total += parseInt(m[1], 10) + parseInt(m[2], 10);
    }
  } catch {
    /* no HEAD or git failure — untracked count still reported */
  }
  const preKeys = new Set(Object.keys(baseline?.workTreeHashes ?? {}));
  for (const p of untrackedPaths) {
    const gitPath = prefix ? prefix + p : p;
    if (preKeys.has(gitPath) || preKeys.has(p)) continue;
    try {
      const text = fs.readFileSync(path.join(rootDir, p), "utf8");
      total += text === "" ? 0 : text.split("\n").length;
    } catch {
      /* binary or vanished — not counted */
    }
  }
  return total;
}
