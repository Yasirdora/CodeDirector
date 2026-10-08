/**
 * `cdir report --attempt N` shows the Nth attempt as it was recorded: its
 * own checks, never a fresh run on today's tree. The current-tree report
 * (no --attempt) still runs the checks live, exactly as before.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { VibeCheck } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { buildReport } from "../src/report/report";
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

/** Lines the counting check has appended so far. */
function lines(file: string): number {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").length;
}

/**
 * A lock whose verifyCommand passes while src/math.js still contains
 * "function add", and appends a line to `marker` — outside the repo — every
 * time it runs. Attempt 1 records that pass; the tests then move the tree
 * on, so the same command would fail if it ran again.
 */
async function setupCountingCheck(): Promise<{ root: string; lock: VibeCheck; marker: string }> {
  const root = makeGitRepo(FILES);
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdir-attempt-")), "checks.log");
  fs.writeFileSync(marker, "");
  const script =
    `${appendTo(marker, "ran\n")}; ` +
    `process.exit(require("fs").readFileSync("src/math.js", "utf8").includes("function add") ? 0 : 1)`;
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

/** The tree moves on: the recorded check would now fail. */
function rewriteMathFile(root: string): void {
  fs.writeFileSync(path.join(root, "src", "math.js"), "// placeholder\n");
}

test("report --attempt: the recorded pass is shown, and the command is not run again", async () => {
  const { root, lock, marker } = await setupCountingCheck();
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", appendTo("src/math.js", "// faster\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.record.violations));
  assert.equal(lines(marker), 1, "attempt 1 ran the check once");

  rewriteMathFile(root);

  const report = await buildReport(root, lock.id, { attempt: 1 });

  assert.equal(report.view, "attempt");
  assert.equal(report.attemptId, outcome.record.attemptId, "bound to attempt 1");
  assert.equal(report.verdict, "verified", report.violations.join("; "));
  const check = report.items.find((i) => i.source === "verify-command");
  assert.equal(check?.verdict, "held", JSON.stringify(report.items.map((i) => [i.subject, i.verdict])));
  assert.equal(lines(marker), 1, "showing the attempt did not run its command on today's tree");
});

test("report --attempt: a record without checks is incomplete, names the attempt, and runs nothing", async () => {
  const { root, lock, marker } = await setupCountingCheck();
  // Verification off writes no `verification` block — the same shape as
  // records from before the ladder stored its result.
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", appendTo("src/math.js", "// faster\n")], {
    stdio: "pipe",
    verify: false,
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.record.verification, undefined);

  const report = await buildReport(root, lock.id, { attempt: 1 });

  assert.equal(report.verdict, "incomplete");
  assert.equal(
    report.incompleteReason,
    `attempt 1 of ${lock.id} recorded no checks — showing an attempt does not run them again on today's tree`,
  );
  assert.equal(lines(marker), 0, "nothing ran while the attempt was shown");
});

test("report: the current-tree report still runs the check live — and now sees it fail", async () => {
  const { root, lock, marker } = await setupCountingCheck();
  await runWithLock(root, lock.id, [NODE, "-e", appendTo("src/math.js", "// faster\n")], { stdio: "pipe" });
  rewriteMathFile(root);

  const report = await buildReport(root, lock.id);

  assert.equal(report.view, "current");
  assert.equal(report.verdict, "failed", report.violations.join("; "));
  assert.equal(lines(marker), 2, "the current-tree report ran the command once, as it always did");
});

test("report --attempt via the CLI: the same verdict as the API, and nothing runs", async () => {
  const { root, lock, marker } = await setupCountingCheck();
  await runWithLock(root, lock.id, [NODE, "-e", appendTo("src/math.js", "// faster\n")], { stdio: "pipe" });
  rewriteMathFile(root);

  const api = await buildReport(root, lock.id, { attempt: 1 });
  const cli = spawnSync(NODE, [CLI, "report", lock.id, "--attempt", "1", "--root", root], {
    encoding: "utf8",
    timeout: 60_000,
  });

  assert.notEqual(cli.status, null, cli.stderr);
  assert.equal(
    cli.status === 0,
    api.verdict === "verified",
    `CLI exit ${cli.status} vs API ${api.verdict}: ${cli.stdout}${cli.stderr}`,
  );
  assert.equal(api.verdict, "verified", api.violations.join("; "));
  assert.ok(cli.stdout.includes("as recorded"), cli.stdout);
  assert.equal(lines(marker), 1, "the CLI ran nothing either");
});
