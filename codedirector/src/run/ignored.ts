/**
 * Files a run hides from git by changing the ignore rules.
 *
 * Classification reads `git status`, and git does not list ignored files. A
 * run that adds `notes.txt` to .gitignore and then creates notes.txt would
 * otherwise change a file nobody judges (reproduced on 0.4.5: a lock that
 * denied .gitignore came out VERIFIED, "1 changed").
 *
 * The baseline keeps the text of every ignore source — each .gitignore in
 * the work tree and .git/info/exclude. After the run, when any of them
 * changed, every path git now ignores under the root is asked one question:
 * would the rules as they were before the run have ignored it? Git answers,
 * not a reimplementation of its matcher: the old rules are written into a
 * scratch repository and `git check-ignore --no-index` is asked there.
 * A path the old rules did not ignore is one the run hid, and is judged
 * like any other change.
 *
 * Out of reach: a global excludes file (core.excludesFile) lives outside
 * the repository, and a run that edits it is not seen here.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface IgnoreRules {
  /** Git-root-relative path of each .gitignore → its text. */
  files: Record<string, string>;
  /** Text of .git/info/exclude, or null when there is none. */
  exclude: string | null;
}

/** More newly ignored files than this and the answer is "too many to list" — judged as the folder. */
export const MAX_NEWLY_IGNORED = 5000;

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
}

function nulList(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

function gitTop(rootDir: string): string | null {
  try {
    return git(rootDir, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return null;
  }
}

function readOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Every ignore source in the repository as it is now; null outside git. */
export function captureIgnoreRules(rootDir: string): IgnoreRules | null {
  const top = gitTop(rootDir);
  if (!top) return null;
  let listing: string[];
  try {
    listing = nulList(
      git(top, ["ls-files", "-z", "--full-name", "--cached", "--others", "--exclude-standard", "--", ":(glob)**/.gitignore"]),
    );
  } catch {
    return null;
  }
  const files: Record<string, string> = {};
  for (const p of [...new Set(listing)].sort()) {
    // cdir's own rules apply inside .codedirector/ only, which is never judged.
    if (p.split("/").includes(".codedirector")) continue;
    const text = readOrNull(path.join(top, p));
    if (text !== null) files[p] = text;
  }
  let exclude: string | null = null;
  try {
    exclude = readOrNull(path.resolve(rootDir, git(rootDir, ["rev-parse", "--git-path", "info/exclude"]).trim()));
  } catch {
    exclude = null;
  }
  return { files, exclude };
}

export function ignoreRulesChanged(before: IgnoreRules, after: IgnoreRules): boolean {
  if (before.exclude !== after.exclude) return true;
  const keys = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  for (const k of keys) if (before.files[k] !== after.files[k]) return true;
  return false;
}

/** Git's answer to "which of these git-root-relative paths do these rules ignore?". */
function ignoredUnder(rules: IgnoreRules, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-ignore-"));
  try {
    git(scratch, ["init", "-q"]);
    for (const [p, text] of Object.entries(rules.files)) {
      const abs = path.join(scratch, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    fs.mkdirSync(path.join(scratch, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(scratch, ".git", "info", "exclude"), rules.exclude ?? "");
    let out = "";
    try {
      out = git(scratch, ["check-ignore", "--no-index", "--stdin", "-z"], paths.join("\0") + "\0");
    } catch (e) {
      // check-ignore exits 1 when nothing is ignored: that is an answer, not a failure.
      const err = e as { status?: number; stdout?: string };
      if (err.status !== 1) throw e;
      out = err.stdout ?? "";
    }
    return new Set(nulList(out));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Git-root-relative files under a work-tree directory, capped. */
function filesUnder(top: string, dir: string, cap: number): string[] | null {
  const out: string[] = [];
  const walk = (rel: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(top, rel), { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}${e.name}`;
      if (e.isDirectory()) {
        if (e.name === ".git") continue;
        if (!walk(`${child}/`)) return false;
      } else {
        out.push(child);
        if (out.length > cap) return false;
      }
    }
    return true;
  };
  return walk(dir) ? out : null;
}

/**
 * Git-root-relative paths under rootDir that git ignores now but the
 * `before` rules did not: what the run's rule changes hid. A folder whose
 * files are too many to list is returned as the folder ("dir/").
 */
export function newlyIgnoredPaths(rootDir: string, before: IgnoreRules): string[] {
  const top = gitTop(rootDir);
  if (!top) return [];
  // Ignored now, folders collapsed — an ignored node_modules/ is one entry.
  const entries = nulList(
    git(rootDir, ["ls-files", "-z", "--full-name", "--others", "--ignored", "--exclude-standard", "--directory"]),
  ).filter((p) => !p.split("/").includes(".codedirector"));
  if (entries.length === 0) return [];

  const wasIgnored = ignoredUnder(before, entries);
  const out: string[] = [];
  const expand: string[] = [];
  for (const e of entries) {
    if (wasIgnored.has(e)) continue; // hidden before the run too
    if (e.endsWith("/")) expand.push(e);
    else out.push(e);
  }
  // A folder the old rules did not ignore may still hold files they did
  // (`*.log` inside a newly ignored `notes/`): ask about each file.
  for (const dir of expand) {
    const files = filesUnder(top, dir, MAX_NEWLY_IGNORED);
    if (files === null) {
      out.push(dir);
      continue;
    }
    const alsoBefore = ignoredUnder(before, files);
    out.push(...files.filter((f) => !alsoBefore.has(f)));
  }
  return [...new Set(out)].sort();
}
