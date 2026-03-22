/**
 * Historical co-change coupling from git history.
 *
 * Runs `git log --name-only` for the defining file and counts how often
 * other files appear in the same commits. Degrades gracefully: any failure
 * (not a git repo, no history, git missing) returns an empty result with
 * available=false rather than throwing.
 */

import { execFileSync } from "node:child_process";

export interface CoChangeResult {
  available: boolean;
  /** Human-readable reason when unavailable. */
  reason?: string;
  /** Commits examined that touched the file. */
  commitsExamined: number;
  /** Top co-changing files, sorted by shared-commit count desc, path asc. */
  top: Array<{ file: string; sharedCommits: number }>;
}

export function coChange(rootDir: string, relFile: string, limit = 5, maxCommits = 500): CoChangeResult {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["log", `--max-count=${maxCommits}`, "--pretty=format:--COMMIT--", "--name-only", "--", relFile],
      { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
  } catch (err) {
    const msg = err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    const reason = msg.includes("not a git repository")
      ? "not a git repository"
      : "git history unavailable";
    return { available: false, reason, commitsExamined: 0, top: [] };
  }

  const counts = new Map<string, number>();
  let commits = 0;
  for (const chunk of out.split("--COMMIT--")) {
    const files = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (files.length === 0) continue;
    commits++;
    const unique = new Set(files);
    unique.delete(relFile);
    for (const f of unique) counts.set(f, (counts.get(f) ?? 0) + 1);
  }

  const top = [...counts.entries()]
    .map(([file, sharedCommits]) => ({ file, sharedCommits }))
    .sort((a, b) => b.sharedCommits - a.sharedCommits || a.file.localeCompare(b.file))
    .slice(0, limit);

  return { available: true, commitsExamined: commits, top };
}

export function isGitRepo(rootDir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
