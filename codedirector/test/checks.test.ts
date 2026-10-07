/**
 * Required checks by changed area (.codedirector/checks.yaml): the loader,
 * the matching rule, and the four places the rules bite — drafting,
 * activation, the run, and the report — plus `cdir checks`.
 *
 * Commands are neutral (`echo …`): the rules treat them as opaque strings.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { defaultDomains } from "../src/domain/registry";
import { checksNeededBy, joinRuns, loadChecks, runsCheck, CHECKS_FILE, ChecksRules } from "../src/config/checks";
import { draftLock, estimateVerifyTimeoutMs } from "../src/lock/draft";
import { checkLock } from "../src/lock/check";
import { loadLock, saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { VibeCheck } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { requiredCheckViolations } from "../src/run/classify";
import { buildReport } from "../src/report/report";
import { formatReportJson } from "../src/report/format";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;
const CLI = path.join(__dirname, "..", "src", "cli.js");
const STAMP = "2026-10-08T00:00:00.000Z";
const append = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

const FILES = {
  "src/core/a.js": "export const a = 1;\n",
  "src/shared/b.js": "export const b = 2;\n",
  "web/c.js": "export const c = 3;\n",
  "docs/readme.md": "# docs\n",
};

const RULES = `schemaVersion: 1
checks:
  unit: echo unit-check
  app:
    run: echo app-check OUT=/tmp/app
    match: echo app-check
areas:
  - paths: [src/core/**, src/shared/**]
    need: [unit, app]
  - paths: [web/**]
    need: [unit]
turns: "echo turn"
`;

const UNIT_AND_APP = "echo unit-check && echo app-check OUT=/tmp/app";
const appMissing = (file: string, more = "") =>
  `CHECKS: verifyCommand does not run "app" (echo app-check), which ${file} needs${more}`;

function writeRules(root: string, text: string): void {
  fs.mkdirSync(path.join(root, ".codedirector"), { recursive: true });
  fs.writeFileSync(path.join(root, CHECKS_FILE), text);
}

function repoWithRules(text = RULES): string {
  const root = makeGitRepo(FILES);
  writeRules(root, text);
  return root;
}

function rulesOf(text: string): ChecksRules {
  const file = loadChecks(repoWithRules(text));
  assert.equal(file.status, "rules", JSON.stringify(file));
  return (file as { rules: ChecksRules }).rules;
}

/** An approved, active lock. Its verifyCommand is set by hand, so the draft's own fill does not interfere. */
async function activeLock(
  root: string,
  budgetFiles: string[],
  verifyCommand: string | undefined,
  customize?: (lock: VibeCheck) => void,
): Promise<VibeCheck> {
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "tweak the core", {
    now: STAMP,
    createdBy: "test",
    budgetFiles,
    verifyCommand: "true",
  });
  lock.verifyCommand = verifyCommand;
  lock.keep = [];
  lock.deny = [];
  customize?.(lock);
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return lock;
}

// ---------------------------------------------------------------------
// 1. The loader

test("loader: short and long forms; match defaults to run; order and turns kept", () => {
  const rules = rulesOf(RULES);
  assert.deepEqual(rules.checks, [
    { name: "unit", run: "echo unit-check", match: "echo unit-check" },
    { name: "app", run: "echo app-check OUT=/tmp/app", match: "echo app-check" },
  ]);
  assert.deepEqual(rules.areas, [
    { paths: ["src/core/**", "src/shared/**"], need: ["unit", "app"] },
    { paths: ["web/**"], need: ["unit"] },
  ]);
  assert.equal(rules.turns, "echo turn");
});

test("loader: no file is not an error, and a file with only a version asks for nothing", () => {
  assert.deepEqual(loadChecks(makeGitRepo(FILES)), { status: "absent" });
  const rules = rulesOf("schemaVersion: 1\n");
  assert.deepEqual([rules.checks, rules.areas], [[], []]);
});

const INVALID: Array<[string, string, string]> = [
  ["a missing schemaVersion", "checks: {}\n", "schemaVersion must be 1, got undefined"],
  ["a wrong schemaVersion", "schemaVersion: 2\n", "schemaVersion must be 1, got 2"],
  ["an unknown top-level key (a typo for areas)", "schemaVersion: 1\narea: []\n", 'top level has unknown key "area"'],
  ["an unknown check in need", "schemaVersion: 1\nareas:\n  - paths: [src]\n    need: [nope]\n", 'names "nope", which is not in checks'],
  ["a bad check name", "schemaVersion: 1\nchecks:\n  Unit: echo x\n", "a check name must match"],
  ["an empty command", 'schemaVersion: 1\nchecks:\n  unit: ""\n', "checks.unit must be a non-empty string"],
  ["a blank run in the long form", 'schemaVersion: 1\nchecks:\n  unit:\n    run: "  "\n', "checks.unit.run must be a non-empty string"],
  ["an empty match", 'schemaVersion: 1\nchecks:\n  unit:\n    run: echo x\n    match: ""\n', "checks.unit.match must be a non-empty string"],
  ["an unknown key in a check", "schemaVersion: 1\nchecks:\n  unit:\n    run: echo x\n    mach: echo\n", 'checks.unit has unknown key "mach"'],
  ["a check that is neither command nor mapping", "schemaVersion: 1\nchecks:\n  unit: [echo x]\n", "checks.unit must be a command"],
  ["a bad glob", "schemaVersion: 1\nchecks:\n  unit: echo x\nareas:\n  - paths: ['../x/**']\n    need: [unit]\n", "areas[0].paths[0]"],
  ["no paths", "schemaVersion: 1\nchecks:\n  unit: echo x\nareas:\n  - paths: []\n    need: [unit]\n", "areas[0].paths must be a non-empty list"],
  ["nothing needed", "schemaVersion: 1\nchecks:\n  unit: echo x\nareas:\n  - paths: [src]\n    need: []\n", "areas[0].need must be a non-empty list"],
  ["an area that is not a mapping", "schemaVersion: 1\nareas: [src]\n", "areas[0] must be a mapping"],
  ["turns that is not a string", "schemaVersion: 1\nturns: 5\n", "turns must be a non-empty string"],
  ["a duplicate check name", "schemaVersion: 1\nchecks:\n  unit: a\n  unit: b\n", "invalid YAML"],
  ["YAML that does not parse", "schemaVersion: 1\nchecks: [\n", "invalid YAML"],
  ["a top level that is not a mapping", "- schemaVersion\n", "top level must be a mapping"],
];

for (const [what, text, reason] of INVALID) {
  test(`loader: ${what} is invalid, and the error names the file and the reason`, () => {
    const file = loadChecks(repoWithRules(text));
    assert.equal(file.status, "invalid");
    const error = (file as { error: string }).error;
    assert.ok(error.startsWith(`${CHECKS_FILE} is invalid: `), error);
    assert.ok(error.includes(reason), error);
  });
}

test("loader: a rules file that cannot be read is invalid, not absent", () => {
  const root = makeGitRepo(FILES);
  fs.mkdirSync(path.join(root, CHECKS_FILE), { recursive: true });
  const file = loadChecks(root);
  assert.equal(file.status, "invalid");
  assert.ok((file as { error: string }).error.includes("could not be read"));
});

// ---------------------------------------------------------------------
// 2. Matching

test("matching: the union over areas, in the order the checks are listed", () => {
  const rules = rulesOf(
    `schemaVersion: 1
checks:
  unit: echo unit
  app: echo app
  lint: echo lint
areas:
  - paths: [src/core/**]
    need: [lint, app]
  - paths: [src/**]
    need: [lint, unit]
`,
  );
  const needed = checksNeededBy(rules, ["src/core/a.js", "src/shared/b.js", "docs/readme.md"]);
  assert.deepEqual(
    needed.map((n) => [n.check.name, n.files]),
    [
      ["unit", ["src/core/a.js", "src/shared/b.js"]],
      ["app", ["src/core/a.js"]],
      ["lint", ["src/core/a.js", "src/shared/b.js"]],
    ],
  );
  assert.equal(joinRuns(needed), "echo unit && echo app && echo lint");
});

test("matching: a plain path is a directory prefix; a file in no area needs nothing", () => {
  const rules = rulesOf("schemaVersion: 1\nchecks:\n  unit: echo unit\nareas:\n  - paths: [web]\n    need: [unit]\n");
  assert.equal(checksNeededBy(rules, ["web/c.js", "web/deep/d.js"]).length, 1);
  assert.deepEqual(checksNeededBy(rules, ["website/c.js", "docs/readme.md", "src/core/a.js"]), []);
});

test("matching: a verifyCommand runs a check when its match text is in it, whitespace collapsed", () => {
  const check = { name: "app", run: "make   app", match: "make app OUT=/x" };
  assert.ok(runsCheck("echo hi &&\n  make\tapp   OUT=/x && echo done", check));
  assert.ok(!runsCheck("make app OUT=/y", check));
  assert.ok(!runsCheck("", check));
  // Nothing cleverer: a longer word that contains the text counts.
  assert.ok(runsCheck("make app OUT=/xyz", check));
});

// ---------------------------------------------------------------------
// 3. Draft

test("draft: fills verifyCommand from the checks the budget files need, in rules order, with a timeout", async () => {
  const root = repoWithRules();
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "tweak it", {
    now: STAMP,
    createdBy: "test",
    budgetFiles: ["web/c.js", "src/core/a.js"],
  });
  assert.equal(lock.verifyCommand, UNIT_AND_APP);
  assert.equal(lock.verifyTimeoutMs, estimateVerifyTimeoutMs(UNIT_AND_APP, defaultDomains()));
  assert.equal(loadLock(root, lock.id)!.verifyCommand, UNIT_AND_APP, "and it is what was saved");

  const web = draftLock(root, index, "tweak web", { now: STAMP, createdBy: "test", budgetFiles: ["web/c.js"] });
  assert.equal(web.lock.verifyCommand, "echo unit-check");
});

test("draft: a given verifyCommand and timeout are left alone", async () => {
  const root = repoWithRules();
  const { index } = await buildIndex(root);
  const given = draftLock(root, index, "tweak it", {
    now: STAMP,
    createdBy: "test",
    budgetFiles: ["src/core/a.js"],
    verifyCommand: "true",
  });
  assert.equal(given.lock.verifyCommand, "true");

  const timed = draftLock(root, index, "tweak it", {
    now: STAMP,
    createdBy: "test",
    budgetFiles: ["src/core/a.js"],
    verifyTimeoutMs: 5000,
  });
  assert.equal(timed.lock.verifyCommand, UNIT_AND_APP, "filled…");
  assert.equal(timed.lock.verifyTimeoutMs, 5000, "…but the timeout the human gave stays");
});

test("draft: nothing is filled when nothing is needed, for globs, or without a rules file", async () => {
  const root = repoWithRules();
  const { index } = await buildIndex(root);
  for (const budgetFiles of [["docs/readme.md"], ["src/core/**"], []]) {
    const { lock } = draftLock(root, index, "tweak it", { now: STAMP, createdBy: "test", budgetFiles });
    assert.equal(lock.verifyCommand, undefined, JSON.stringify(budgetFiles));
    assert.equal(lock.verifyTimeoutMs, undefined);
  }

  const bare = makeGitRepo(FILES);
  const { lock } = draftLock(bare, (await buildIndex(bare)).index, "tweak it", {
    now: STAMP,
    createdBy: "test",
    budgetFiles: ["src/core/a.js"],
  });
  assert.equal(lock.verifyCommand, undefined);
});

test("draft: a bad rules file fills nothing and says why in the draft", async () => {
  const root = repoWithRules("schemaVersion: 2\n");
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "tweak it", { now: STAMP, createdBy: "test", budgetFiles: ["src/core/a.js"] });
  assert.equal(lock.verifyCommand, undefined);
  assert.ok(
    lock.assumptions.some((a) => a.text.includes("verifyCommand left empty") && a.text.includes("schemaVersion must be 1")),
    JSON.stringify(lock.assumptions),
  );
});

// ---------------------------------------------------------------------
// 4. Activation

test("activation: refuses a verifyCommand that leaves out a needed check, and names the command to use", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js", "web/c.js"], "echo unit-check");
  const result = checkLock(root, lock, null);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    "verifyCommand does not run the check(s) the budget needs: app (src/core/a.js) — " +
      `a verifyCommand that runs them: ${UNIT_AND_APP}`,
  ]);

  lock.verifyCommand = undefined;
  assert.deepEqual(checkLock(root, lock, null).errors, [
    "verifyCommand does not run the check(s) the budget needs: unit (src/core/a.js, web/c.js), app (src/core/a.js) — " +
      `a verifyCommand that runs them: ${UNIT_AND_APP}`,
  ]);
});

test("activation: passes when the verifyCommand runs every needed check, however it is written", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js", "web/c.js"], "echo   unit-check &&\n echo app-check");
  assert.deepEqual(checkLock(root, lock, null).errors, []);
});

test("activation: globs and files no area names are not judged", async () => {
  const root = repoWithRules();
  const globs = await activeLock(root, ["src/core/**"], undefined);
  assert.deepEqual(checkLock(root, globs, null).errors, []);
  const docs = await activeLock(root, ["docs/readme.md"], undefined);
  assert.deepEqual(checkLock(root, docs, null).errors, []);
});

test("activation: a bad rules file refuses, naming the file and the reason", async () => {
  const root = repoWithRules("schemaVersion: 2\n");
  const lock = await activeLock(root, ["docs/readme.md"], "echo unit-check");
  const result = checkLock(root, lock, null);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [`${CHECKS_FILE} is invalid: schemaVersion must be 1, got 2`]);
});

test("activation: without a rules file nothing changes", async () => {
  const root = makeGitRepo(FILES);
  const lock = await activeLock(root, ["src/core/a.js"], undefined);
  assert.deepEqual(checkLock(root, lock, null).errors, []);
});

// ---------------------------------------------------------------------
// 5. Run

test("run: a verifyCommand that passes but leaves out a needed check fails, with the CHECKS line", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js"], "echo unit-check");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// x\n")], { stdio: "pipe" });
  assert.equal(
    outcome.record.verification!.items.find((i) => i.source === "verify-command")!.verdict,
    "held",
    "the verifyCommand itself passed",
  );
  assert.deepEqual(outcome.record.violations, [appMissing("src/core/a.js")]);
  assert.equal(outcome.exitCode, 1);
  assert.equal(loadLock(root, lock.id)!.status, "failed");
});

test("run: the same change with the check present is verified", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js"], "echo unit-check && echo app-check");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// x\n")], { stdio: "pipe" });
  assert.deepEqual(outcome.record.violations, []);
  assert.equal(outcome.exitCode, 0);
  assert.equal(loadLock(root, lock.id)!.status, "verified");
});

test("run: --allow-expand drops the scope violations and keeps the CHECKS violation", async () => {
  const touchTwo = `${append("src/core/a.js", "// x\n")};${append("src/shared/b.js", "// y\n")}`;

  const strict = repoWithRules();
  const lock = await activeLock(strict, ["src/core/a.js"], "echo unit-check");
  const refused = await runWithLock(strict, lock.id, [NODE, "-e", touchTwo], { stdio: "pipe" });
  assert.deepEqual(refused.record.violations, [
    "OUT-OF-BUDGET: src/shared/b.js is not in budget.files",
    "BUDGET: 2 files changed > maxFiles 1",
    appMissing("src/core/a.js", " (+1 more)"),
  ]);

  const expand = repoWithRules();
  const expandLock = await activeLock(expand, ["src/core/a.js"], "echo unit-check");
  const accepted = await runWithLock(expand, expandLock.id, [NODE, "-e", touchTwo], { stdio: "pipe", allowExpand: true });
  assert.deepEqual(accepted.record.violations, [appMissing("src/core/a.js", " (+1 more)")]);
  assert.equal(accepted.exitCode, 1);
  assert.equal(loadLock(expand, expandLock.id)!.status, "failed");
});

test("run: a bad rules file fails the run closed, with one violation", async () => {
  const root = repoWithRules("schemaVersion: 2\n");
  const lock = await activeLock(root, ["docs/readme.md"], "echo unit-check");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("docs/readme.md", "x\n")], { stdio: "pipe" });
  assert.deepEqual(outcome.record.violations, [`CHECKS: ${CHECKS_FILE} is invalid: schemaVersion must be 1, got 2`]);
  assert.equal(outcome.exitCode, 1);
});

test("run: the violation wording is produced in one place, one line per missing check", () => {
  const rules = rulesOf(RULES);
  const changed = (...paths: string[]) => paths.map((p) => ({ path: p, status: "M", class: "in-budget" as const }));
  const rulesFile = { status: "rules" as const, rules };

  assert.deepEqual(requiredCheckViolations(changed("src/core/a.js", "web/c.js", "src/shared/b.js"), undefined, rulesFile), [
    'CHECKS: verifyCommand does not run "unit" (echo unit-check), which src/core/a.js needs (+2 more)',
    appMissing("src/core/a.js", " (+1 more)"),
  ]);
  assert.deepEqual(requiredCheckViolations(changed("docs/readme.md"), undefined, rulesFile), []);
  assert.deepEqual(requiredCheckViolations(changed("web/c.js"), "echo unit-check", rulesFile), []);
  assert.deepEqual(requiredCheckViolations(changed("web/c.js"), "echo unit-check", { status: "absent" }), []);
  assert.deepEqual(requiredCheckViolations([], "x", { status: "invalid", error: "the file is broken" }), [
    "CHECKS: the file is broken",
  ]);
});

// ---------------------------------------------------------------------
// 6. Report

test("report: the live report, the current-tree report and the attempt view give the same CHECKS line", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js"], "echo unit-check");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// x\n")], { stdio: "pipe" });

  const live = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    run: outcome.record,
    runRecordPath: outcome.recordPath,
  });
  const current = await buildReport(root, lock.id);
  const attempt = await buildReport(root, lock.id, { attempt: 1 });

  assert.equal(current.view, "current");
  assert.equal(attempt.view, "attempt");
  for (const report of [live, current, attempt]) {
    assert.equal(report.verdict, "failed");
    assert.deepEqual(report.violations, [appMissing("src/core/a.js")], report.view);
  }
});

test("report: --allow-expand on the run does not excuse a missing check in any view", async () => {
  const root = repoWithRules();
  const lock = await activeLock(root, ["src/core/a.js"], "echo unit-check");
  const touchTwo = `${append("src/core/a.js", "// x\n")};${append("src/shared/b.js", "// y\n")}`;
  await runWithLock(root, lock.id, [NODE, "-e", touchTwo], { stdio: "pipe", allowExpand: true });

  for (const opts of [{}, { attempt: 1 }]) {
    const report = await buildReport(root, lock.id, opts);
    assert.deepEqual(report.violations, [appMissing("src/core/a.js", " (+1 more)")], JSON.stringify(opts));
  }
});

test("report: a closed lock is history — today's rules are not applied to it", async () => {
  const root = makeGitRepo(FILES);
  const first = await activeLock(root, ["src/core/a.js"], "echo unit-check");
  await runWithLock(root, first.id, [NODE, "-e", append("src/core/a.js", "// x\n")], { stdio: "pipe" });
  assert.equal(loadLock(root, first.id)!.status, "verified", "no rules file when it ran");

  // The repo adds its rules. A lock that is still open answers for the tree as it is now…
  writeRules(root, RULES);
  const open = await buildReport(root, first.id);
  assert.equal(open.view, "current");
  assert.deepEqual(open.violations, [appMissing("src/core/a.js")]);

  // …but once the next lock has started, the first one is shown as it was recorded.
  const second = await activeLock(root, ["web/c.js"], "echo unit-check");
  await runWithLock(root, second.id, [NODE, "-e", append("web/c.js", "// y\n")], { stdio: "pipe" });
  const closed = await buildReport(root, first.id);
  assert.equal(closed.closedBy?.lockId, second.id);
  assert.equal(closed.view, "attempt");
  assert.deepEqual(closed.violations, []);
  assert.equal(closed.verdict, "verified");
});

// ---------------------------------------------------------------------
// 7. No rules file

test("no rules file: a run and its reports carry no CHECKS and no new field", async () => {
  const root = makeGitRepo(FILES);
  const lock = await activeLock(root, ["src/core/a.js"], "echo unit-check");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// x\n")], { stdio: "pipe" });
  assert.deepEqual(outcome.record.violations, []);
  assert.equal(outcome.exitCode, 0);

  const report = await buildReport(root, lock.id);
  assert.equal(report.verdict, "verified");
  assert.deepEqual(report.violations, []);
  assert.ok(!formatReportJson(report).includes("CHECKS"));
});

// ---------------------------------------------------------------------
// 8. cdir checks

function cdirChecks(root: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(NODE, [CLI, "checks", ...args, "--root", root], { encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("cdir checks: without a rules file it says so and exits 0", () => {
  const r = cdirChecks(makeGitRepo(FILES));
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("no rules file"), r.stdout);
});

test("cdir checks: with no paths it validates the file and lists its checks and areas", () => {
  const r = cdirChecks(repoWithRules());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("unit: echo unit-check"), r.stdout);
  assert.ok(r.stdout.includes("app: echo app-check OUT=/tmp/app   [a verifyCommand must contain: echo app-check]"), r.stdout);
  assert.ok(r.stdout.includes("src/core/**, src/shared/**  need  unit, app"), r.stdout);
  assert.ok(r.stdout.includes("web/**  need  unit"), r.stdout);
});

test("cdir checks: with paths it names each needed check and, last, the command that runs them", () => {
  const root = repoWithRules();
  const r = cdirChecks(root, "./src/core/a.js", "web/c.js", "docs/readme.md");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split("\n"), [
    "unit: echo unit-check   (src/core/a.js, web/c.js)",
    "app: echo app-check OUT=/tmp/app   (src/core/a.js)",
    `a verifyCommand that runs them: ${UNIT_AND_APP}`,
  ]);

  assert.ok(cdirChecks(root, "docs/readme.md").stdout.includes("no check is needed for these paths"));

  const json = JSON.parse(cdirChecks(root, "web/c.js", "--json").stdout);
  assert.deepEqual(json, {
    status: "rules",
    needed: [{ name: "unit", run: "echo unit-check", match: "echo unit-check", files: ["web/c.js"] }],
    command: "echo unit-check",
  });
});

test("cdir checks: a bad file exits 1 with the file and the reason", () => {
  const root = repoWithRules("schemaVersion: 2\n");
  const r = cdirChecks(root);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`${CHECKS_FILE} is invalid: schemaVersion must be 1, got 2`), r.stderr);
  const asked = cdirChecks(root, "web/c.js");
  assert.equal(asked.status, 1, "with paths too");

  const json = cdirChecks(root, "--json");
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), { status: "invalid", error: `${CHECKS_FILE} is invalid: schemaVersion must be 1, got 2` });
});
