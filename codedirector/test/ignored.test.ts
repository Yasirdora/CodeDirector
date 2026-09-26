/**
 * A run cannot hide what it changes by changing what git ignores
 * (ROADMAP 0.4.6, reproduced on 0.4.5 and on the domain-split main: a lock
 * denying .gitignore came out VERIFIED, "1 changed").
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { VibeCheck } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { captureIgnoreRules, ignoreRulesChanged, newlyIgnoredPaths } from "../src/run/ignored";
import { git, makeGitRepo } from "./helpers";

const NODE = process.execPath;

async function activeLock(root: string, budget: string[], deny: string[] = []): Promise<VibeCheck> {
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "edit a", { now: "2026-09-26T00:00:00.000Z", createdBy: "test" });
  lock.budget = { files: budget, symbols: [], maxFiles: 10, maxLines: 400 };
  lock.deny = deny;
  lock.keep = [];
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return lock;
}

function fsScript(body: string): string[] {
  return [NODE, "-e", `const f=require("fs");${body}`];
}

const REPO = { "src/a.ts": "export const a = 1;\n", ".gitignore": "dist/\n*.log\n" };

test("ignored: editing a denied .gitignore is a DENY, and the file it hides is judged", async () => {
  const root = makeGitRepo(REPO);
  const lock = await activeLock(root, ["src/a.ts"], [".gitignore"]);
  const outcome = await runWithLock(
    root,
    lock.id,
    fsScript(`f.appendFileSync("src/a.ts","// x\\n");f.writeFileSync("notes.txt","hidden\\n");f.appendFileSync(".gitignore","notes.txt\\n")`),
    { stdio: "pipe" },
  );
  assert.equal(outcome.exitCode, 1);
  const v = outcome.record.violations.join(" | ");
  assert.match(v, /DENY: \.gitignore/);
  assert.match(v, /OUT-OF-BUDGET: notes\.txt/);
  assert.deepEqual(outcome.record.changed.map((c) => [c.path, c.status]).sort(), [
    [".gitignore", "M"],
    ["notes.txt", "!!"],
    ["src/a.ts", "M"],
  ]);
});

test("ignored: a budgeted .gitignore still cannot hide a file outside the budget, and its lines count", async () => {
  const root = makeGitRepo(REPO);
  const lock = await activeLock(root, ["src/a.ts", ".gitignore"]);
  const outcome = await runWithLock(
    root,
    lock.id,
    fsScript(`f.writeFileSync("notes.txt","one\\ntwo\\nthree\\n");f.appendFileSync(".gitignore","notes.txt\\n")`),
    { stdio: "pipe" },
  );
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.record.violations.join(" | "), /OUT-OF-BUDGET: notes\.txt/);
  assert.ok(outcome.record.budget.linesChanged >= 4, `notes.txt's 3 lines + the rule: ${outcome.record.budget.linesChanged}`);
});

test("ignored: a rule added to .git/info/exclude is seen too, precisely", async () => {
  const root = makeGitRepo(REPO);
  const lock = await activeLock(root, ["src/a.ts"]);
  const outcome = await runWithLock(
    root,
    lock.id,
    fsScript(
      `f.mkdirSync("secret");f.writeFileSync("secret/a.md","x\\n");f.writeFileSync("secret/b.log","x\\n");` +
        `f.appendFileSync(".git/info/exclude","secret/\\n")`,
    ),
    { stdio: "pipe" },
  );
  const changed = outcome.record.changed.map((c) => c.path);
  assert.ok(changed.includes("secret/a.md"), "hidden by the run's new rule");
  assert.ok(!changed.includes("secret/b.log"), "*.log hid it before the run: out of scope, as before");
});

test("ignored: a rule change does not sweep in output that the old rules already ignored", async () => {
  const root = makeGitRepo(REPO);
  const lock = await activeLock(root, ["src/a.ts", ".gitignore"]);
  const outcome = await runWithLock(
    root,
    lock.id,
    fsScript(
      `f.appendFileSync(".gitignore","# tidy\\n");f.mkdirSync("dist");f.writeFileSync("dist/out.js","x\\n");f.writeFileSync("run.log","x\\n")`,
    ),
    { stdio: "pipe" },
  );
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.record.violations));
  assert.deepEqual(outcome.record.changed.map((c) => c.path), [".gitignore"]);
});

test("ignored: hiding a file that already existed, unchanged, is not a change to that file", async () => {
  const root = makeGitRepo(REPO);
  fs.writeFileSync(path.join(root, "scratch.txt"), "the human's notes\n"); // untracked before the run
  const lock = await activeLock(root, ["src/a.ts", ".gitignore"]);
  const outcome = await runWithLock(root, lock.id, fsScript(`f.appendFileSync(".gitignore","scratch.txt\\n")`), { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.record.violations));
  assert.deepEqual(outcome.record.changed.map((c) => c.path), [".gitignore"]);
});

test("ignored: without a rule change nothing ignored is looked at (no cost, no false findings)", () => {
  const root = makeGitRepo(REPO);
  const before = captureIgnoreRules(root)!;
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "out.js"), "x\n");
  assert.equal(ignoreRulesChanged(before, captureIgnoreRules(root)!), false);
  assert.deepEqual(newlyIgnoredPaths(root, before), [], "dist/ was ignored by the old rules");
});

test("ignored: nested .gitignore files and a subfolder root", () => {
  const root = makeGitRepo({ "app/src/a.ts": "export const a = 1;\n", "app/.gitignore": "*.tmp\n", ".gitignore": "dist/\n" });
  const app = path.join(root, "app");
  const before = captureIgnoreRules(app)!;
  assert.deepEqual(Object.keys(before.files), [".gitignore", "app/.gitignore"], "git-root-relative, every level");
  fs.appendFileSync(path.join(app, ".gitignore"), "private/\n");
  fs.mkdirSync(path.join(app, "private"));
  fs.writeFileSync(path.join(app, "private", "k.txt"), "x\n");
  fs.writeFileSync(path.join(app, "x.tmp"), "x\n");
  assert.ok(ignoreRulesChanged(before, captureIgnoreRules(app)!));
  assert.deepEqual(newlyIgnoredPaths(app, before), ["app/private/k.txt"]);
  git(root, ["status", "--porcelain"]); // repository still sane
});

test("ignored: a .gitignore that was dirty before the run, and left alone, is not the run's", async () => {
  const root = makeGitRepo(REPO);
  fs.appendFileSync(path.join(root, ".gitignore"), "# the human's edit\n");
  const lock = await activeLock(root, ["src/a.ts"], [".gitignore"]);
  const outcome = await runWithLock(root, lock.id, fsScript(`f.appendFileSync("src/a.ts","// x\\n")`), { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.record.violations));
  assert.deepEqual(outcome.record.changed.map((c) => c.path), ["src/a.ts"]);
});
