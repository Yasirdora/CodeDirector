/** Shared test helpers (not a test file — imported by *.test.ts). */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export const FIXTURE_REPO = path.join(__dirname, "..", "..", "test", "fixtures", "basic-repo");
export const DEMO_REPO = path.join(__dirname, "..", "..", "examples", "demo-repo");

/** Copy the fixture repo into a fresh temp dir and return its path. */
export function copyFixture(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-test-"));
  fs.cpSync(FIXTURE_REPO, tmp, { recursive: true });
  return tmp;
}

/** Copy the demo repo (src + test) into a fresh temp dir. */
export function copyDemoRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-demo-"));
  fs.cpSync(path.join(DEMO_REPO, "src"), path.join(tmp, "src"), { recursive: true });
  fs.cpSync(path.join(DEMO_REPO, "test"), path.join(tmp, "test"), { recursive: true });
  return tmp;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=cdir-test", "-c", "user.email=cdir-test@local", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}

/**
 * Fresh temp dir as a standalone git repo (rootDir == git root) with one
 * initial commit containing `files` (relpath → contents).
 */
export function makeGitRepo(files: Record<string, string> = { "README.md": "# tmp\n" }): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-git-"));
  git(tmp, ["init", "-q"]);
  for (const [rel, contents] of Object.entries(files)) {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }
  git(tmp, ["add", "-A"]);
  git(tmp, ["commit", "-qm", "init"]);
  return tmp;
}

/** Demo repo as a standalone git repo with an initial commit. */
export function makeDemoGitRepo(): string {
  const tmp = copyDemoRepo();
  git(tmp, ["init", "-q"]);
  git(tmp, ["add", "-A"]);
  git(tmp, ["commit", "-qm", "init"]);
  return tmp;
}

/**
 * The subfolder-project layout: demo repo inside <tmp>/sub, git rooted at
 * <tmp>. A tracked .codedirector/seals.json is committed empty so a later
 * seal write shows up in `git diff --numstat HEAD` — the IL-0012 scenario.
 * Returns rootDir (the sub folder).
 */
export function makeSubfolderDemoGitRepo(): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-subgit-"));
  const sub = path.join(parent, "sub");
  fs.mkdirSync(path.join(sub, ".codedirector"), { recursive: true });
  fs.cpSync(path.join(DEMO_REPO, "src"), path.join(sub, "src"), { recursive: true });
  fs.cpSync(path.join(DEMO_REPO, "test"), path.join(sub, "test"), { recursive: true });
  fs.writeFileSync(path.join(sub, ".codedirector", "seals.json"), "{}\n");
  git(parent, ["init", "-q"]);
  git(parent, ["add", "-A"]);
  git(parent, ["commit", "-qm", "init"]);
  return sub;
}
