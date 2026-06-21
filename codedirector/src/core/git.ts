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

export function coChange(
  rootDir: string,
  relFile: string,
  limit = 5,
  maxCommits = 500,
  minCommits = 30,
): CoChangeResult {
  // Shallow clones and tiny histories make co-change meaningless: on a
  // --depth 1 clone the single commit touches every file, so .editorconfig
  // "couples" with everything (field-reported on Hono). Skip with a named
  // reason rather than reporting noise.
  try {
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    if (shallow === "true") {
      return { available: false, reason: "shallow clone", commitsExamined: 0, top: [] };
    }
    const total = parseInt(
      execFileSync("git", ["rev-list", "--count", "HEAD"], {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }).trim(),
      10,
    );
    if (Number.isFinite(total) && total < minCommits) {
      return {
        available: false,
        reason: `only ${total} commit(s) of history (< ${minCommits}) — coupling would be noise`,
        commitsExamined: 0,
        top: [],
      };
    }
  } catch {
    /* git missing or not a repo — the log call below produces the precise error */
  }

  // Note: `git log --name-only -- <file>` would filter the name list to
  // <file> as well, so we take (capped) full history and filter in-process.
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["log", `--max-count=${maxCommits}`, "--pretty=format:--COMMIT--", "--name-only"],
      { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
  } catch (err) {
    const msg = err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    const reason = msg.includes("not a git repository")
      ? "not a git repository"
      : "git history unavailable";
    return { available: false, reason, commitsExamined: 0, top: [] };
  }

  // Paths from git log are relative to the git work-tree root, which may
  // be a parent of rootDir. Compute the prefix and translate both ways.
  let prefix = "";
  try {
    prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch {
    /* ignore — keep empty prefix */
  }
  const gitRelFile = prefix ? prefix + relFile : relFile;

  const counts = new Map<string, number>();
  let commits = 0;
  for (const chunk of out.split("--COMMIT--")) {
    const files = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (files.length === 0) continue;
    const unique = new Set(files);
    if (!unique.has(gitRelFile)) continue;
    commits++;
    unique.delete(gitRelFile);
    for (const f of unique) {
      const rel = prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f;
      counts.set(rel, (counts.get(rel) ?? 0) + 1);
    }
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
