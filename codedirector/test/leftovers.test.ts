/**
 * Closing a lock properly, and warning about work left behind: `cdir lock
 * abandon`, the leftovers helper, the warnings shown when new work starts
 * (CLI and MCP), and the two report notes — verified but not committed, and a
 * run whose command changed nothing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { leftBehind, leftBehindWarnings } from "../src/lock/leftovers";
import { canonicalLockHash, readSeals, sealLock, sealViolation } from "../src/lock/seal";
import { loadLock, lockPathFor, saveLock } from "../src/lock/store";
import { LockStatus, VibeCheck } from "../src/lock/types";
import { RunError, runWithLock } from "../src/run/run";
import { buildReport, ChangeReport, finalizeLockStatus } from "../src/report/report";
import { git, makeGitRepo, makeSubfolderDemoGitRepo } from "./helpers";

const NODE = process.execPath;
const CLI = path.join(__dirname, "..", "src", "cli.js");
const append = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

const FILES = {
  "src/math.js": `export function add(a, b) { return a + b; }\n`,
  "src/other.js": `export function sub(a, b) { return a - b; }\n`,
};

const NOT_COMMITTED = "Verified, not committed yet: 1 file(s) — commit them with the lock's records.";
const NO_CHANGE =
  "The command changed no file. If it should have, the run proves nothing about the change " +
  "(a patch applied from the wrong folder is skipped silently).";

/** A sealed, active lock whose budget is `files`. */
async function newLock(root: string, utterance: string, files: string[]): Promise<VibeCheck> {
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, utterance, { now: "2026-10-08T00:00:00.000Z", createdBy: "test" });
  lock.keep = [];
  lock.budget = { files, symbols: [], maxFiles: 10, maxLines: 400 };
  lock.change = "test";
  lock.goal = "test";
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return lock;
}

/** Run a node one-liner inside the lock, the way a builder would. */
function runIn(root: string, lock: VibeCheck, code: string) {
  return runWithLock(root, lock.id, [NODE, "-e", code], { stdio: "pipe" });
}

/** A lock that ran and left src/math.js changed; failed because its command exited 1. */
async function failedLock(root: string): Promise<VibeCheck> {
  const lock = await newLock(root, "make math faster", ["src/math.js"]);
  await runIn(root, lock, `${append("src/math.js", "// faster\n")};process.exit(1)`);
  assert.equal(loadLock(root, lock.id)!.status, "failed");
  return lock;
}

function setStatus(root: string, id: string, status: LockStatus): void {
  const lock = loadLock(root, id)!;
  lock.status = status;
  saveLock(root, lock);
}

/** What `git` sees of the work tree, apart from Code Director's own state. */
function treeState(root: string): string {
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter((l) => l && !l.includes(".codedirector"));
  return JSON.stringify({ status, diff: git(root, ["diff"]) });
}

function cdir(root: string, ...args: string[]) {
  // --root goes first: everything after a bare `--` is the command of `cdir run`.
  const r = spawnSync(NODE, [CLI, "--root", root, ...args], { encoding: "utf8", timeout: 60_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

async function reportOf(root: string, lock: VibeCheck): Promise<ChangeReport> {
  return buildReport(root, lock.id);
}

const findingTexts = (r: ChangeReport) => r.findings.map((f) => f.text);

// --- abandon ---------------------------------------------------------------

test("abandon: closes a lock from any status but abandoned, recording the reason", async () => {
  const root = makeGitRepo(FILES);
  for (const status of ["draft", "active", "verified", "failed", "incomplete"] as LockStatus[]) {
    const lock = await newLock(root, `work while ${status}`, ["src/math.js"]);
    setStatus(root, lock.id, status);
    const r = cdir(root, "lock", "abandon", lock.id, "--reason", `gave up while ${status}`);
    assert.equal(r.status, 0, `${status}: ${r.err}`);
    assert.match(r.out, new RegExp(`${lock.id} is now abandoned`));
    const closed = loadLock(root, lock.id)!;
    assert.equal(closed.status, "abandoned", status);
    assert.deepEqual(closed.assumptions.at(-1), {
      text: `abandoned: gave up while ${status}`,
      source: "user",
      confirmed: true,
    });
  }
});

test("abandon: refused when already abandoned, without a reason, or for no such lock", async () => {
  const root = makeGitRepo(FILES);
  const lock = await newLock(root, "make math faster", ["src/math.js"]);
  const file = () => fs.readFileSync(lockPathFor(root, lock.id)!, "utf8");
  const before = file();

  for (const args of [["--reason"], ["--reason", "   "]]) {
    const r = cdir(root, "lock", "abandon", lock.id, ...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.err, /requires --reason/);
  }
  assert.equal(cdir(root, "lock", "abandon", "IL-9999", "--reason", "x").status, 1);
  assert.equal(cdir(root, "lock", "abandon", "--reason", "x").status, 2, "the id is required too");
  assert.equal(file(), before, "a refusal changes nothing");

  assert.equal(cdir(root, "lock", "abandon", lock.id, "--reason", "first").status, 0);
  const closed = file();
  const again = cdir(root, "lock", "abandon", lock.id, "--reason", "second");
  assert.equal(again.status, 1);
  assert.match(again.err, /already abandoned/);
  assert.equal(file(), closed, "the second try records nothing");
});

test("abandon: is in the help", () => {
  const r = spawnSync(NODE, [CLI, "help"], { encoding: "utf8" });
  assert.match(r.stdout, /cdir lock abandon <id> --reason/);
});

test("abandon: leaves the tree as it is and lists the lock's changes that are still uncommitted", async () => {
  const root = makeGitRepo(FILES);
  const lock = await newLock(root, "make math faster", ["src/math.js", "src/new.js"]);
  await runIn(root, lock, `${append("src/math.js", "// faster\n")};${append("src/new.js", "// new\n")}`);
  const before = treeState(root);

  const r = cdir(root, "lock", "abandon", lock.id, "--reason", "wrong approach");
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /still uncommitted:\n {2}src\/math\.js\n {2}src\/new\.js\n/);
  assert.match(r.out, /nothing was changed in the tree/);
  assert.match(r.out, /git checkout -- <files>/);
  assert.match(r.out, /cdir undo/);
  assert.equal(treeState(root), before, "the tree is exactly as it was");

  // Once the files are committed there is nothing to list.
  git(root, ["add", "src"]);
  git(root, ["commit", "-qm", "keep it"]);
  const other = await newLock(root, "tidy other", ["src/other.js"]);
  const clean = cdir(root, "lock", "abandon", other.id, "--reason", "not needed");
  assert.equal(clean.status, 0, clean.err);
  assert.ok(!clean.out.includes("uncommitted"), clean.out);
});

test("abandon: an abandoned lock cannot run, its seal still matches, and a report cannot reopen it", async () => {
  const root = makeGitRepo(FILES);
  const lock = await failedLock(root);
  assert.equal(cdir(root, "lock", "abandon", lock.id, "--reason", "start over").status, 0);

  await assert.rejects(runIn(root, lock, "0"), (e: unknown) => e instanceof RunError && /abandoned/.test(e.message));
  const closed = loadLock(root, lock.id)!;
  assert.equal(sealViolation(root, closed), null);
  assert.equal(readSeals(root)[lock.id], canonicalLockHash(closed), "saving re-pinned the seal");

  const report = await reportOf(root, lock);
  assert.equal(report.lockId, lock.id, "a report on it works");
  assert.equal(finalizeLockStatus(root, report).status, "abandoned");
  assert.equal(loadLock(root, lock.id)!.status, "abandoned", "judging the tree does not reopen it");
});

// --- left behind -----------------------------------------------------------

test("leftovers: a failed lock's uncommitted files are listed until they are committed or reverted", async () => {
  const root = makeGitRepo(FILES);
  const lock = await failedLock(root);
  assert.deepEqual(leftBehind(root, "IL-9999"), [{ lockId: lock.id, status: "failed", files: ["src/math.js"] }]);

  git(root, ["add", "src"]);
  git(root, ["commit", "-qm", "keep it"]);
  assert.deepEqual(leftBehind(root, "IL-9999"), [], "committed");

  const again = await newLock(root, "more math", ["src/other.js", "src/made.js"]);
  await runIn(root, again, `${append("src/other.js", "// x\n")};${append("src/made.js", "// y\n")};process.exit(1)`);
  assert.deepEqual(leftBehind(root, "IL-9999").map((l) => l.files), [["src/made.js", "src/other.js"]], "tracked and untracked");
  git(root, ["checkout", "--", "src/other.js"]);
  fs.rmSync(path.join(root, "src/made.js"));
  assert.deepEqual(leftBehind(root, "IL-9999"), [], "reverted");
});

test("leftovers: newest lock first; abandoned, draft, never-run and the lock starting now are skipped", async () => {
  const root = makeGitRepo(FILES);
  const first = await failedLock(root);
  const second = await newLock(root, "tidy other", ["src/other.js"]);
  await runIn(root, second, append("src/other.js", "// tidy\n"));
  const neverRan = await newLock(root, "idle", ["src/math.js"]);
  const draft = await newLock(root, "not yet", ["src/math.js"]);
  setStatus(root, draft.id, "draft");

  const ids = () => leftBehind(root, "IL-9999").map((l) => `${l.lockId} ${l.status}`);
  assert.deepEqual(ids(), [`${second.id} verified`, `${first.id} failed`]);
  assert.deepEqual(leftBehind(root, second.id).map((l) => l.lockId), [first.id], "the lock being activated is not listed");
  assert.ok(!ids().some((i) => i.startsWith(neverRan.id)), "a lock that never ran left nothing");

  setStatus(root, first.id, "abandoned");
  assert.deepEqual(ids(), [`${second.id} verified`], "abandoned locks are never listed");
});

test("leftovers: a file belongs to the newest lock that changed it, not to an older one", async () => {
  const root = makeGitRepo(FILES);
  const older = await newLock(root, "make math faster", ["src/math.js", "src/other.js"]);
  await runIn(root, older, `${append("src/math.js", "// a\n")};${append("src/other.js", "// a\n")}`);
  git(root, ["add", "src"]);
  git(root, ["commit", "-qm", "older"]);
  const newer = await newLock(root, "math again", ["src/math.js"]);
  await runIn(root, newer, append("src/math.js", "// b\n"));
  const left = (except: string) => leftBehind(root, except).map((l) => `${l.lockId} ${l.files}`);

  assert.deepEqual(left("IL-9999"), [`${newer.id} src/math.js`], "the older lock's file is dirty because of the newer one");
  assert.deepEqual(left(newer.id), [], "the lock starting now owns it, so nobody is named");

  // Both locks left a file of their own: each is named for its own only.
  const third = await newLock(root, "other again", ["src/other.js"]);
  await runIn(root, third, append("src/other.js", "// c\n"));
  const fourth = await newLock(root, "math third time", ["src/math.js"]);
  await runIn(root, fourth, append("src/math.js", "// d\n"));
  assert.deepEqual(left("IL-9999"), [`${fourth.id} src/math.js`, `${third.id} src/other.js`]);
});

test("leftovers: a file an abandoned newer lock changed does not put the blame on an older lock", async () => {
  const root = makeGitRepo(FILES);
  const older = await newLock(root, "make math faster", ["src/math.js"]);
  await runIn(root, older, append("src/math.js", "// a\n"));
  git(root, ["add", "src"]);
  git(root, ["commit", "-qm", "older"]);
  const newer = await newLock(root, "math again", ["src/math.js"]);
  await runIn(root, newer, `${append("src/math.js", "// b\n")};process.exit(1)`);
  assert.deepEqual(leftBehind(root, "IL-9999").map((l) => l.lockId), [newer.id]);

  setStatus(root, newer.id, "abandoned");
  assert.deepEqual(leftBehind(root, "IL-9999"), [], "the abandoned lock owns the file and is never warned about");
});

test("leftovers: paths are root-relative when the repo is a subfolder of the git root", async () => {
  const root = makeSubfolderDemoGitRepo();
  const lock = await newLock(root, "tune the preview", ["src/preview.ts"]);
  await runIn(root, lock, `${append("src/preview.ts", "// tuned\n")};process.exit(1)`);
  assert.deepEqual(leftBehind(root, "IL-9999"), [{ lockId: lock.id, status: "failed", files: ["src/preview.ts"] }]);
});

test("leftovers: the warning says what the lock left, names at most five files, and tells the owner what to do", async () => {
  const root = makeGitRepo(FILES);
  const lock = await newLock(root, "make many files", ["gen/**"]);
  const make = [1, 2, 3, 4, 5, 6, 7].map((n) => append(`gen/f${n}.js`, "x\n")).join(";");
  await runIn(root, lock, `require("fs").mkdirSync("gen");${make};process.exit(1)`);
  const id = lock.id;
  assert.deepEqual(leftBehindWarnings(root, "IL-9999"), [
    `${id} (failed) left changes in the tree: gen/f1.js, gen/f2.js, gen/f3.js, gen/f4.js, gen/f5.js, +2 more. ` +
      `This lock will count them as already there. ` +
      `Finish ${id}, or close it (cdir lock abandon ${id} --reason "…") and keep or drop its changes.`,
  ]);

  setStatus(root, id, "verified");
  assert.deepEqual(leftBehindWarnings(root, "IL-9999"), [
    `${id} is verified but not committed: gen/f1.js, gen/f2.js, gen/f3.js, gen/f4.js, gen/f5.js, +2 more. ` +
      `Commit it before new work, so this lock's report shows only its own changes.`,
  ]);
  setStatus(root, id, "incomplete");
  assert.match(leftBehindWarnings(root, "IL-9999")[0], /^IL-\d{4} \(incomplete\) left changes in the tree: /);
  setStatus(root, id, "active");
  assert.match(leftBehindWarnings(root, "IL-9999")[0], /^IL-\d{4} \(active\) left changes in the tree: /);
});

// --- warnings when work starts ---------------------------------------------

test("cli: lock new and lock activate warn about a failed lock's changes, and still succeed", async () => {
  const root = makeGitRepo(FILES);
  const failed = await failedLock(root);
  const warning = `⚠ ${failed.id} (failed) left changes in the tree: src/math.js. This lock will count them as already there.`;

  const drafted = cdir(root, "lock", "new", "tidy the other file", "--budget-files", "src/other.js");
  assert.equal(drafted.status, 0, drafted.err);
  assert.ok(drafted.out.includes(warning), drafted.out);
  const newId = /drafted (IL-\d{4})/.exec(drafted.out)![1];

  const activated = cdir(root, "lock", "activate", newId);
  assert.equal(activated.status, 0, activated.err);
  assert.match(activated.out, new RegExp(`${newId} is now active`));
  assert.ok(activated.out.includes(warning), activated.out);
  assert.equal(loadLock(root, newId)!.status, "active");

  // With the changes committed there is nothing to say.
  git(root, ["add", "src"]);
  git(root, ["commit", "-qm", "keep it"]);
  const quiet = cdir(root, "lock", "new", "one more", "--budget-files", "src/other.js");
  assert.equal(quiet.status, 0, quiet.err);
  assert.ok(!quiet.out.includes("⚠"), quiet.out);
});

async function connect(root: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({ command: NODE, args: [CLI, "mcp", "--root", root], stderr: "pipe" });
  const client = new Client({ name: "cdir-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

test("mcp: lock_draft and lock_activate carry the warnings, and activation still succeeds", async () => {
  const root = makeGitRepo(FILES);
  const failed = await failedLock(root);
  const warning = `${failed.id} (failed) left changes in the tree: src/math.js. This lock will count them as already there.`;
  const { client, close } = await connect(root);
  try {
    const draft = await client.callTool({
      name: "lock_draft",
      arguments: { utterance: "tidy the other file", budgetFiles: ["src/other.js"] },
    });
    const info = JSON.parse(textOf(draft));
    assert.equal(info.warnings.length, 1, textOf(draft));
    assert.ok(info.warnings[0].startsWith(warning), info.warnings[0]);

    const act = await client.callTool({ name: "lock_activate", arguments: { lockId: info.lockId } });
    assert.ok(!(act as { isError?: boolean }).isError, textOf(act));
    const [line, ...warnings] = textOf(act).split("\n");
    assert.equal(line, `${info.lockId} is now active — execute ONLY via run_locked ${info.lockId}`);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].startsWith(`⚠ ${warning}`), warnings[0]);
    assert.equal(loadLock(root, info.lockId)!.status, "active");
  } finally {
    await close();
  }
});

test("mcp: with nothing left behind the answers are what they were", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    const draft = await client.callTool({ name: "lock_draft", arguments: { utterance: "tidy", budgetFiles: ["src/other.js"] } });
    const info = JSON.parse(textOf(draft));
    assert.ok(!("warnings" in info), "no warnings field");
    const act = await client.callTool({ name: "lock_activate", arguments: { lockId: info.lockId } });
    assert.equal(textOf(act), `${info.lockId} is now active — execute ONLY via run_locked ${info.lockId}`);
  } finally {
    await close();
  }
});

// --- report notes ----------------------------------------------------------

test("report: a verified lock whose files are not committed says so, and the verdict stays verified", async () => {
  const root = makeGitRepo(FILES);
  const lock = await newLock(root, "make math faster", ["src/math.js"]);
  await runIn(root, lock, append("src/math.js", "// faster\n"));

  const report = await reportOf(root, lock);
  assert.equal(report.verdict, "verified");
  assert.deepEqual(report.violations, []);
  assert.equal(report.view, "current");
  const note = report.findings.find((f) => f.text === NOT_COMMITTED);
  assert.equal(note?.evidenceClass, "asserted");

  const recorded = await buildReport(root, lock.id, { attempt: 1 });
  assert.ok(!findingTexts(recorded).includes(NOT_COMMITTED), "an attempt view is history");

  git(root, ["add", "src"]);
  git(root, ["commit", "-qm", "faster math"]);
  const committed = await reportOf(root, lock);
  assert.equal(committed.verdict, "verified");
  assert.ok(!findingTexts(committed).includes(NOT_COMMITTED), "committed: no note");
});

test("report: a failed lock gets no 'not committed' note", async () => {
  const root = makeGitRepo(FILES);
  const lock = await newLock(root, "make math faster", ["src/math.js"]);
  await runIn(root, lock, append("src/other.js", "// out of budget\n"));

  const report = await reportOf(root, lock);
  assert.equal(report.verdict, "failed");
  assert.ok(!findingTexts(report).some((t) => t.startsWith("Verified, not committed")), findingTexts(report).join("; "));
});

// --- run note --------------------------------------------------------------

test("run: a command that exits 0 and changes nothing is noted, and the verdict is as it was", async () => {
  const root = makeGitRepo(FILES);
  const lock = await newLock(root, "make math faster", ["src/math.js"]);
  const outcome = await runIn(root, lock, "0");
  assert.equal(outcome.exitCode, 0);

  const report = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    run: outcome.record,
    runRecordPath: outcome.recordPath,
  });
  assert.equal(report.verdict, "verified");
  assert.deepEqual(findingTexts(report), [NO_CHANGE]);
});

test("run: a command that changes a file, or fails, gets no such note", async () => {
  const root = makeGitRepo(FILES);
  const lock = await newLock(root, "make math faster", ["src/math.js"]);

  const changed = await runIn(root, lock, append("src/math.js", "// faster\n"));
  const withChange = await buildReport(root, lock.id, {
    verification: changed.record.verification,
    run: changed.record,
    runRecordPath: changed.recordPath,
  });
  assert.ok(!findingTexts(withChange).includes(NO_CHANGE));

  const quiet = await newLock(root, "tidy other", ["src/other.js"]);
  const failedRun = await runIn(root, quiet, "process.exit(1)");
  const report = await buildReport(root, quiet.id, {
    verification: failedRun.record.verification,
    run: failedRun.record,
    runRecordPath: failedRun.recordPath,
  });
  assert.equal(report.verdict, "failed");
  assert.ok(!findingTexts(report).includes(NO_CHANGE), "only a command that succeeded is asked about");
});

test("cli: `cdir run` shows the note when the command changed nothing", async () => {
  const root = makeGitRepo(FILES);
  const lock = await newLock(root, "make math faster", ["src/math.js"]);
  const r = cdir(root, "run", lock.id, "--", NODE, "-e", "0");
  assert.equal(r.status, 0, r.out + r.err);
  assert.ok(r.out.includes(NO_CHANGE), r.out);
});
