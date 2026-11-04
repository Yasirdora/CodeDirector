/**
 * W4: a current-tree report reuses the last attempt's checks while the tree is
 * exactly that attempt's after-state, and runs them again only when the tree
 * moved or a re-verify is asked for. The verifyCommand counts its own runs in
 * a file outside the repo, so "nothing re-ran" is evidence, not narration.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { loadLock, saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { VibeCheck } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { buildReport, finalizeLockStatus } from "../src/report/report";
import { formatReport } from "../src/report/format";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;
/** dist/src/cli.js once built — the compiled tests live in dist/test. */
const CLI = path.join(__dirname, "..", "src", "cli.js");
const appendTo = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

const FILES = {
  "src/math.js": `export function add(a, b) { return a + b; }\n`,
  "test/math.test.js":
    `import test from "node:test";\nimport assert from "node:assert/strict";\n` +
    `import { add } from "../src/math.js";\ntest("add works", () => assert.equal(add(2, 3), 5));\n`,
};

/** Runs the counting check has recorded so far. */
function runs(file: string): number {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").length;
}

/**
 * A lock whose verifyCommand appends a line to `marker` — outside the repo —
 * every time it runs. "always" passes; "once" passes on its first run only
 * (the shape of a check a load spike flips); "never" fails every time.
 */
async function setupCheck(
  pass: "always" | "once" | "never",
): Promise<{ root: string; lock: VibeCheck; marker: string }> {
  const root = makeGitRepo(FILES);
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdir-reuse-")), "checks.log");
  fs.writeFileSync(marker, "");
  const decision = pass === "never" ? "false" : pass === "once" ? "n === 0" : "true";
  const script =
    `const fs = require("fs");` +
    `const f = ${JSON.stringify(marker)};` +
    `const n = fs.readFileSync(f, "utf8").split("\\n").filter(Boolean).length;` +
    `fs.appendFileSync(f, "ran\\n");` +
    `process.exit(${decision} ? 0 : 1);`;
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make math faster", {
    now: "2026-10-08T00:00:00.000Z",
    createdBy: "test",
  });
  lock.keep = [];
  lock.budget = { files: ["src/math.js"], symbols: [], maxFiles: 3, maxLines: 400 };
  lock.change = "math internals only";
  lock.goal = "same behavior, faster";
  lock.verifyCommand = `${JSON.stringify(NODE)} -e ${JSON.stringify(script)}`;
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return { root, lock, marker };
}

/** One attempt that appends "// faster" to src/math.js and passes. */
async function runOnce(root: string, lockId: string) {
  const outcome = await runWithLock(root, lockId, [NODE, "-e", appendTo("src/math.js", "// faster\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.record.violations));
  return outcome;
}

test("report: an unchanged tree shows the attempt's checks — the command does not run again", async () => {
  const { root, lock, marker } = await setupCheck("once");
  await runOnce(root, lock.id);
  assert.equal(runs(marker), 1, "the run ran the check once");
  assert.equal(loadLock(root, lock.id)!.status, "verified");

  const report = await buildReport(root, lock.id);
  finalizeLockStatus(root, report);

  assert.equal(report.view, "current");
  // The claim first: on a tree the attempt left unchanged, nothing runs again.
  assert.equal(runs(marker), 1, "the report ran nothing");
  assert.equal(report.checksFrom?.reused, true, String(JSON.stringify(report.checksFrom)));
  assert.equal(report.verdict, "verified", report.violations.join("; "));
  assert.equal(loadLock(root, lock.id)!.status, "verified", "the passed attempt's verdict stands");
  const text = formatReport(report);
  assert.ok(text.includes("Checks from attempt 1 ("), text.slice(0, 500));
  assert.ok(text.includes("tree unchanged since — nothing re-run"), text.slice(0, 500));
});

test("report: one changed byte in a changed file re-runs the checks and says so", async () => {
  const { root, lock, marker } = await setupCheck("always");
  await runOnce(root, lock.id);
  assert.equal(runs(marker), 1);

  fs.appendFileSync(path.join(root, "src", "math.js"), "// one more\n");

  const report = await buildReport(root, lock.id);
  assert.equal(report.checksFrom?.reused, false);
  assert.equal(report.checksFrom?.reason, "tree-changed");
  assert.equal(report.verdict, "verified", report.violations.join("; "));
  assert.equal(runs(marker), 2, "the moved tree was checked again");
  assert.ok(formatReport(report).includes("Tree changed since attempt 1"), formatReport(report).slice(0, 500));
});

test("report: a new file the run did not touch sends the report back through the checks", async () => {
  const { root, lock, marker } = await setupCheck("always");
  await runOnce(root, lock.id);
  assert.equal(runs(marker), 1);

  fs.writeFileSync(path.join(root, "notes.txt"), "outside the budget\n");

  const report = await buildReport(root, lock.id);
  assert.equal(report.checksFrom?.reused, false);
  assert.equal(report.checksFrom?.reason, "tree-changed");
  assert.equal(runs(marker), 2, "scope is judged again — the command ran again");
  assert.equal(report.verdict, "failed");
  assert.ok(report.violations.some((v) => v.includes("OUT-OF-BUDGET: notes.txt")), report.violations.join("; "));
});

test("report --reverify and reverify: true run the checks on an unchanged tree", async () => {
  const { root, lock, marker } = await setupCheck("once");
  await runOnce(root, lock.id);
  assert.equal(runs(marker), 1);

  const api = await buildReport(root, lock.id, { reverify: true });
  assert.equal(api.checksFrom?.reused, false);
  assert.equal(api.checksFrom?.reason, "reverify");
  assert.equal(runs(marker), 2, "the explicit re-verify ran the check again");
  assert.equal(api.verdict, "failed", "the check's second run decides this report");
  assert.ok(formatReport(api).includes("Re-verify requested"), formatReport(api).slice(0, 400));

  const cli = spawnSync(NODE, [CLI, "report", lock.id, "--reverify", "--format", "json", "--root", root], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.notEqual(cli.status, null, cli.stderr);
  assert.equal(runs(marker), 3, "the CLI flag is the same explicit re-verify");
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.checksFrom?.reused, false);
  assert.equal(parsed.checksFrom?.reason, "reverify");
});

test("cdir verify still runs the checks on an unchanged tree", async () => {
  const { root, lock, marker } = await setupCheck("always");
  await runOnce(root, lock.id);
  assert.equal(runs(marker), 1);

  const cli = spawnSync(NODE, [CLI, "verify", lock.id, "--root", root], { encoding: "utf8", timeout: 60_000 });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(runs(marker), 2, "verify is the explicit command: it runs the checks");
  assert.ok(cli.stdout.includes("Re-verify requested"), cli.stdout.slice(0, 600));
});

test("report: a record without after-state hashes re-runs the checks, as today", async () => {
  const { root, lock, marker } = await setupCheck("always");
  const outcome = await runOnce(root, lock.id);
  assert.equal(runs(marker), 1);

  const record = JSON.parse(fs.readFileSync(outcome.recordPath, "utf8"));
  delete record.afterHashes;
  fs.writeFileSync(outcome.recordPath, JSON.stringify(record));

  const report = await buildReport(root, lock.id);
  assert.equal(report.checksFrom?.reused, false);
  assert.equal(report.checksFrom?.reason, "no-after-hashes");
  assert.equal(runs(marker), 2, "no after-hashes: the report runs the checks, as it always did");
  assert.equal(report.verdict, "verified", report.violations.join("; "));
  assert.ok(formatReport(report).includes("recorded no after-state hashes — checks re-run now"));
});

test("report: a recorded failed attempt keeps its verdict on an unchanged tree, and nothing re-runs", async () => {
  const { root, lock, marker } = await setupCheck("never");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", appendTo("src/math.js", "// faster\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 1, "the check failed the attempt");
  assert.equal(runs(marker), 1);
  assert.equal(loadLock(root, lock.id)!.status, "failed");

  const report = await buildReport(root, lock.id);
  finalizeLockStatus(root, report);
  assert.equal(report.checksFrom?.reused, true);
  assert.equal(report.verdict, "failed", "the verdict is the attempt's");
  assert.equal(runs(marker), 1, "the report ran nothing");
  assert.equal(loadLock(root, lock.id)!.status, "failed");
});
