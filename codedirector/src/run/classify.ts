/**
 * Change classification: every file the command touched is classified
 * against the Lock — denied, in-budget, or out-of-budget.
 *
 * Deny wins over budget: a path matching both is reported as denied (the
 * DENY list is the stronger statement of intent).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { IntentLock } from "../lock/types";
import { matchPath } from "../lock/glob";
import { dirtyPaths, gitPrefix, gitStatusPorcelain, toRootRelative } from "../checkpoint";

export type ChangeClass = "denied" | "out-of-budget" | "in-budget";

export interface ClassifiedChange {
  path: string;
  /** porcelain status letters, e.g. "M", "??", "A" */
  status: string;
  class: ChangeClass;
  /** The deny pattern that matched, when class is "denied". */
  matchedDeny?: string;
}

/**
 * Files changed relative to HEAD right now (tracked modifications +
 * untracked), as paths relative to rootDir. When rootDir is a subdirectory
 * of a larger git work tree, paths outside rootDir are excluded — the
 * Lock's budget speaks in rootDir-relative paths only.
 */
export function changedFiles(rootDir: string): Array<{ path: string; status: string }> {
  const porcelain = gitStatusPorcelain(rootDir);
  const prefix = gitPrefix(rootDir);
  const out: Array<{ path: string; status: string }> = [];
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2).trim();
    for (const p of dirtyPaths(line)) {
      const rel = toRootRelative(prefix, p);
      if (rel === null) continue; // outside rootDir's subtree
      if (rel.split("/").includes(".codedirector")) continue;
      out.push({ path: rel, status });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Classify a single path against the Lock. */
export function classifyPath(lock: IntentLock, relPath: string): ClassifiedChange {
  for (const d of lock.deny) {
    if (matchPath(d, relPath)) {
      return { path: relPath, status: "", class: "denied", matchedDeny: d };
    }
  }
  const inBudget = lock.budget.files.some((f) => matchPath(f, relPath));
  return { path: relPath, status: "", class: inBudget ? "in-budget" : "out-of-budget" };
}

/** Classify all currently-changed files against the Lock. */
export function classifyChanges(rootDir: string, lock: IntentLock): ClassifiedChange[] {
  return changedFiles(rootDir).map((c) => ({ ...classifyPath(lock, c.path), status: c.status }));
}

/**
 * Lines changed (added + deleted) across the working tree vs HEAD, plus the
 * full line count of untracked files. Used for budget.maxLines.
 */
export function changedLineCount(rootDir: string, untrackedPaths: string[]): number {
  let total = 0;
  const prefix = gitPrefix(rootDir);
  try {
    const numstat = execFileSync("git", ["diff", "--numstat", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    for (const line of numstat.split("\n")) {
      const m = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
      if (!m) continue;
      const rel = toRootRelative(prefix, m[3]);
      if (rel === null) continue; // outside rootDir's subtree
      total += parseInt(m[1], 10) + parseInt(m[2], 10);
    }
  } catch {
    /* no HEAD or git failure — untracked count still reported */
  }
  for (const p of untrackedPaths) {
    try {
      const text = fs.readFileSync(path.join(rootDir, p), "utf8");
      total += text === "" ? 0 : text.split("\n").length;
    } catch {
      /* binary or vanished — not counted */
    }
  }
  return total;
}
