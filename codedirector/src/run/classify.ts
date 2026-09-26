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
import { execFileSync, spawnSync } from "node:child_process";
import { VibeCheck } from "../lock/types";
import { matchPath } from "../lock/glob";
import { gitPrefix, gitStatusPorcelain, porcelainLinePaths, toRootRelative } from "../checkpoint";
import { Baseline } from "./baseline";
// Type-only, so nothing is imported at runtime and run.ts -> classify.ts
// stays a one-way edge.
import type { BudgetStats, RunRecord } from "./run";
import { captureIgnoreRules, ignoreRulesChanged, newlyIgnoredPaths } from "./ignored";
import {
  ABSENT,
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
  /** porcelain status letters, e.g. "M", "??", "A", "R"; "!!" for a file the run's ignore rules hid */
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
      if (p.split("/").includes(".codedirector")) continue;
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
  // .gitignore files are judged like any other file. They used to be
  // skipped because cdir wrote its own block there; since IL-0020 it never
  // does, and the skip let a run hide what it created (ROADMAP 0.4.6).
  const add = (gitPath: string, status: string) => {
    if (gitPath.split("/").includes(".codedirector")) return;
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

  // 5. Files the run's own ignore-rule changes hid from git ("!!", git's
  //    mark for an ignored file). Only asked when a rule changed: a new file
  //    matching a rule that already existed stays out of scope, as before.
  if (baseline.ignoreRules) {
    const now = captureIgnoreRules(rootDir);
    if (now && ignoreRulesChanged(baseline.ignoreRules, now)) {
      for (const p of newlyIgnoredPaths(rootDir, baseline.ignoreRules)) add(p, "!!");
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
      const now = hashGitPath(rootDir, gitPath) ?? hashGitPath(rootDir, rel) ?? ABSENT;
      if (now === preHash) continue; // pre-existing dirt (or deletion), untouched
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

/**
 * The scope half of a verdict, in words.
 *
 * Lives here rather than at the call site because two callers need it — the
 * live run, and a standalone verify judging a recorded run again — and two
 * spellings of one verdict would be free to drift apart.
 */
export function scopeViolations(changed: ClassifiedChange[], budget: BudgetStats): string[] {
  const out: string[] = [];
  for (const c of changed) {
    if (c.class === "denied") {
      out.push(`DENY: ${c.path} matches deny pattern "${c.matchedDeny}"`);
    } else if (c.class === "out-of-budget") {
      out.push(`OUT-OF-BUDGET: ${c.path} is not in budget.files`);
    }
  }
  if (budget.filesChanged > budget.maxFiles) {
    out.push(`BUDGET: ${budget.filesChanged} files changed > maxFiles ${budget.maxFiles}`);
  }
  if (budget.linesChanged > budget.maxLines) {
    out.push(`BUDGET: ${budget.linesChanged} lines changed > maxLines ${budget.maxLines}`);
  }
  return out;
}

/** A recorded run, judged again against a Lock that may have moved on. */
export interface Rejudged {
  changed: ClassifiedChange[];
  budget: BudgetStats;
  violations: string[];
}

/**
 * Judge a recorded run against the Lock as it stands NOW.
 *
 * A stored run holds everything this needs — the paths it touched, their
 * statuses, and the measured file and line counts — so nothing is re-run and
 * no tree is re-read. `classifyPath` is already a pure function of the Lock
 * and a path.
 *
 * `linesChanged` is carried over rather than recomputed. It is a measurement
 * against the run's own baseline, and re-deriving it would mean re-diffing a
 * tree that has since moved on; the measured number compared against the
 * current ceiling is the question actually being asked.
 *
 * A run made under `--allow-expand` is rejudged without scope violations,
 * because that is what the override recorded at the time.
 */
export function rejudgeRun(
  run: Pick<RunRecord, "changed" | "budget" | "allowExpand">,
  lock: VibeCheck,
): Rejudged {
  const changed = run.changed.map((c) => ({ ...classifyPath(lock, c.path), status: c.status }));
  const budget: BudgetStats = {
    filesChanged: run.budget.filesChanged,
    linesChanged: run.budget.linesChanged,
    maxFiles: lock.budget.maxFiles,
    maxLines: lock.budget.maxLines,
  };
  return {
    changed,
    budget,
    violations: run.allowExpand ? [] : scopeViolations(changed, budget),
  };
}

/** Classify all run-touched files against the Lock. */
export function classifyChanges(rootDir: string, lock: VibeCheck, baseline?: Baseline | null): ClassifiedChange[] {
  return changedFiles(rootDir, baseline).map((c) => ({ ...classifyPath(lock, c.path), status: c.status }));
}

/**
 * One touched file's line delta. When the baseline holds a tree copy of the
 * file (it was dirty at capture), the run's delta is the exact diff against
 * that copy — `git diff --no-index` exits 1 on differences, so stdout is
 * parsed regardless of exit code. A file the run deleted contributes the
 * copy's full line count. Without a copy (clean at baseline) the vs-HEAD
 * numstat is already exact. A copy whose bytes no longer match the
 * capture-time hash (rewritten mid-run) is distrusted: fall back to the
 * conservative vs-HEAD count.
 */
function lineDelta(
  rootDir: string,
  treeDir: string | undefined,
  gitPath: string,
  expectedCopyHash: string | undefined,
  vsHead: number,
): number {
  if (!treeDir || !expectedCopyHash) return vsHead;
  const copyAbs = path.join(rootDir, treeDir, gitPath);
  let copyBytes: Buffer;
  try {
    copyBytes = fs.readFileSync(copyAbs);
  } catch {
    return vsHead; // no copy for this path
  }
  if (sha256Bytes(copyBytes) !== expectedCopyHash) return vsHead;
  const curAbs = path.join(rootDir, gitToAbsRel(rootDir, gitPath));
  if (!fs.existsSync(curAbs)) {
    // deleted by the run: the run removed the whole baseline-copy content
    const text = copyBytes.toString("utf8");
    return text === "" ? 0 : text.split("\n").length;
  }
  const res = spawnSync("git", ["diff", "--no-index", "--numstat", "--", copyAbs, curAbs], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 15000,
  });
  const m = /^(\d+)\t(\d+)\t/.exec(res.stdout ?? "");
  return m ? parseInt(m[1], 10) + parseInt(m[2], 10) : vsHead;
}

/**
 * Lines changed by the run, plus the full line count of newly untracked
 * files. A file whose bytes are unchanged since baseline is skipped
 * outright (cheap first gate — pre-existing dirt is not the run's fault).
 * Touched files are measured exactly: against the baseline tree copy when
 * the file was dirty at capture (the run's delta only), else against the
 * baseline HEAD. A committed-during-run file needs no special case: its
 * current bytes differ from the copy / baseline HEAD, so it is counted.
 */
export function changedLineCount(rootDir: string, untrackedPaths: string[], baseline?: Baseline | null): number {
  let total = 0;
  const prefix = gitPrefix(rootDir);
  const from = baseline?.head ?? "HEAD";
  const pre = baseline?.workTreeHashes ?? {};
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
      if (m[3].split("/").includes(".codedirector")) continue; // the counter ignores cdir's own state, as the classifier does
      const rel = toRootRelative(prefix, m[3]);
      const preHash = pre[m[3]] ?? (rel !== null ? pre[rel] : undefined);
      if (preHash !== undefined) {
        const now = hashGitPath(rootDir, m[3]) ?? (rel !== null ? hashGitPath(rootDir, rel) : null) ?? ABSENT;
        if (now === preHash) continue; // pre-existing dirt (or deletion), untouched by the run
      }
      total += lineDelta(rootDir, baseline?.treeDir, m[3], preHash, parseInt(m[1], 10) + parseInt(m[2], 10));
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
      // porcelain collapses an untracked folder to one ?? dir/ entry —
      // expand it and count its files (a lock may create files in new folders)
      try {
        const abs = path.join(rootDir, p);
        if (fs.statSync(abs).isDirectory()) total += dirLineCount(abs);
      } catch {
        /* binary or vanished — not counted */
      }
    }
  }
  return total;
}

/** Sum the line counts of every text file under dir. */
function dirLineCount(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".codedirector" || entry.name === ".git" || entry.name === "node_modules") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirLineCount(p);
    } else if (entry.isFile()) {
      try {
        const text = fs.readFileSync(p, "utf8");
        total += text === "" ? 0 : text.split("\n").length;
      } catch {
        /* unreadable — not counted */
      }
    }
  }
  return total;
}
