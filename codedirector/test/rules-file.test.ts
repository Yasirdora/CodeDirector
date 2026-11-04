/**
 * `.codedirector/checks.yaml` is a project file, not cdir's own state: a run
 * that edits it is classified, counted and denied like any other change, and
 * cannot drop a check for itself. State under .codedirector/ (locks, runs,
 * seals, baselines, checkpoints, the index) stays out of every report.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { CHECKS_FILE } from "../src/config/checks";
import { draftLock } from "../src/lock/draft";
import { saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { VibeCheck } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { buildReport } from "../src/report/report";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;
const append = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;
const write = (file: string, text: string) =>
  `require("fs").writeFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

const RULES = `schemaVersion: 1
checks:
  unit: echo unit-check
areas:
  - paths: [src/**]
    need: [unit]
`;

function repoWithRules(rules = RULES): string {
  return makeGitRepo({
    "src/core/a.js": "export const a = 1;\n",
    "docs/readme.md": "# docs\n",
    [CHECKS_FILE]: rules,
  });
}

async function activeLock(
  root: string,
  budgetFiles: string[],
  verifyCommand: string,
  customize?: (lock: VibeCheck) => void,
): Promise<VibeCheck> {
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "tweak the core", {
    now: "2026-11-04T00:00:00.000Z",
    createdBy: "test",
    budgetFiles,
    verifyCommand: "true",
  });
  lock.verifyCommand = verifyCommand;
  lock.keep = [];
  lock.deny = [];
  lock.budget = {
    files: budgetFiles,
    symbols: [],
    maxFiles: Math.max(budgetFiles.length, 1),
    maxLines: 400,
  };
  customize?.(lock);
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return lock;
}

test("rules file: a denied edit to checks.yaml fails the run as DENIED", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js"], "true", (l) => {
    l.deny = [CHECKS_FILE];
  });
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append(CHECKS_FILE, "# denied\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 1);
  assert.ok(
    outcome.record.violations.some((v) => v.startsWith(`DENY: ${CHECKS_FILE}`)),
    outcome.record.violations.join("; "),
  );
  assert.equal(outcome.record.changed.find((c) => c.path === CHECKS_FILE)?.class, "denied");
});

test("rules file: in budget, it is counted with its lines", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js", CHECKS_FILE], "true", (l) => {
    l.budget.maxLines = 10;
  });
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append(CHECKS_FILE, "# one\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.equal(outcome.record.changed.find((c) => c.path === CHECKS_FILE)?.class, "in-budget");
  assert.equal(outcome.record.budget.linesChanged, 1);
});

test("rules file: out of budget is OUT-OF-BUDGET", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js"], "true");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append(CHECKS_FILE, "# x\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 1);
  assert.ok(
    outcome.record.violations.some((v) => v.startsWith(`OUT-OF-BUDGET: ${CHECKS_FILE}`)),
    outcome.record.violations.join("; "),
  );
  assert.equal(outcome.record.changed.find((c) => c.path === CHECKS_FILE)?.class, "out-of-budget");
});

test("rules file: pre-existing dirt is not the run's, and only the run's lines count", async () => {
  const root = repoWithRules();
  fs.appendFileSync(path.join(root, CHECKS_FILE), "# pre-existing 1\n# pre-existing 2\n# pre-existing 3\n");
  const lock = await activeLock(root, ["src/core/a.js", CHECKS_FILE], "true", (l) => {
    l.budget.maxLines = 2;
  });
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append(CHECKS_FILE, "# run\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.equal(outcome.record.changed.find((c) => c.path === CHECKS_FILE)?.class, "in-budget");
  assert.equal(outcome.record.budget.linesChanged, 1, "the run's one line, not the pre-existing three");
});

test("rules file: an untouched pre-existing edit is not blamed on the run", async () => {
  const root = repoWithRules();
  fs.appendFileSync(path.join(root, CHECKS_FILE), "# pre-existing\n");
  const lock = await activeLock(root, ["src/core/a.js"], "echo unit-check");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// ok\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.deepEqual(outcome.record.changed.map((c) => c.path), ["src/core/a.js"]);
});

test("rules file: locks, runs, seals, baselines and the index are never judged", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js"], "echo unit-check");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// ok\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.deepEqual(outcome.record.changed.map((c) => c.path), ["src/core/a.js"]);

  // A current-tree report re-reads the delta after the run wrote its state.
  const report = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    reverify: true,
  });
  assert.deepEqual(report.changed.map((c) => c.path), ["src/core/a.js"]);
  for (const state of [
    ".codedirector/locks",
    ".codedirector/runs",
    ".codedirector/seals",
    ".codedirector/baselines",
    ".codedirector/index.json",
    ".codedirector/checkpoints.json",
  ]) {
    assert.ok(!report.changed.some((c) => c.path === state || c.path.startsWith(`${state}/`)), state);
  }
});

test("rules file: a run that writes the first checks.yaml is judged by it — absent at the baseline is an answer", async () => {
  const root = makeGitRepo({ "src/core/a.js": "export const a = 1;\n" });
  const lock = await activeLock(root, ["src/core/a.js", CHECKS_FILE], "echo something-else");
  const command = `${append("src/core/a.js", "// changed\n")};${write(CHECKS_FILE, RULES)}`;
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", command], { stdio: "pipe" });
  assert.equal(outcome.record.changed.find((c) => c.path === CHECKS_FILE)?.class, "in-budget");
  // One line: the check the new rules ask for. No line about the baseline.
  assert.equal(outcome.record.violations.length, 1, outcome.record.violations.join("; "));
  assert.ok(outcome.record.violations[0].startsWith('CHECKS: verifyCommand does not run "unit"'));
  assert.equal(outcome.exitCode, 1);
});

test("rules file: any other file under .codedirector/ stays cdir's — a note left there is not judged", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js"], "echo unit-check");
  const command = `${append("src/core/a.js", "// ok\n")};${write(".codedirector/HANDOFF-note.md", "# for the next session\n")}`;
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", command], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.deepEqual(outcome.record.changed.map((c) => c.path), ["src/core/a.js"]);
});

test("rules file: a run cannot drop a needed check by editing checks.yaml", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js", CHECKS_FILE], "echo something-else", (l) => {
    l.budget.maxLines = 400;
  });
  const command = `${append("src/core/a.js", "// changed\n")};${write(CHECKS_FILE, "schemaVersion: 1\n")}`;
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", command], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 1);
  assert.ok(
    outcome.record.violations.some(
      (v) => v.startsWith('CHECKS: verifyCommand does not run "unit"') && v.includes("src/core/a.js"),
    ),
    outcome.record.violations.join("; "),
  );

  // The report applies both rule sets too, not only the run.
  const report = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    reverify: true,
  });
  assert.ok(
    report.violations.some((v) => v.startsWith('CHECKS: verifyCommand does not run "unit"')),
    report.violations.join("; "),
  );
});
