/**
 * A verifyCommand made of the checks in .codedirector/checks.yaml runs as
 * named steps: the same text in the same shell, a silent marker before each
 * check. These tests hold the promise that makes that safe — the marked
 * command says and exits exactly as the command as written — and what it
 * buys: each check's time, the check a run failed in, progress while it
 * runs, and a report that prints the long command once.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { RepoIndex } from "../src/core/types";
import { CheckDef } from "../src/config/checks";
import { LOCK_SCHEMA_VERSION, VibeCheck } from "../src/lock/types";
import { draftLock } from "../src/lock/draft";
import { saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { runWithLock } from "../src/run/run";
import { buildReport } from "../src/report/report";
import { formatReportMarkdown, formatReport } from "../src/report/format";
import {
  END_MARK,
  formatDuration,
  markedCommand,
  readStepTimes,
  STEP_DIR_ENV,
  stepsOf,
  stepTimesLine,
  type CheckStep,
} from "../src/verify/steps";
import { declaredButUnrunnable, VerificationItem } from "../src/verify/types";
import { verifyWithBaseline } from "../src/verify/verify";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;

const checksOf = (pairs: Array<[string, string]>): CheckDef[] => pairs.map(([name, run]) => ({ name, run, match: run }));
const stepsFrom = (runs: string[]): CheckStep[] => runs.map((run, i) => ({ name: `s${i}`, run }));

/** What a shell says and how it ends, for one command. */
function shell(command: string, stepDir?: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, ...(stepDir !== undefined ? { [STEP_DIR_ENV]: stepDir } : {}) },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ---------------------------------------------------------------------
// 1. Which commands are named checks

test("steps: a command that is exactly the checks' texts joined is read as those checks, in order", () => {
  const checks = checksOf([["prepare", "sh prep.sh"], ["help", "npx vitest run src/lib/help"], ["web", "npx vitest run src/lib"]]);
  assert.deepEqual(
    stepsOf("sh prep.sh && npx vitest run src/lib && npx vitest run src/lib/help", checks)?.map((s) => s.name),
    ["prepare", "web", "help"],
    "a text that begins another's ends where a join does, never inside it",
  );
  assert.deepEqual(stepsOf("sh prep.sh", checks)?.map((s) => s.name), ["prepare"]);
});

test("steps: any other command runs as written — edited, extended, spaced differently or empty", () => {
  const checks = checksOf([["a", "echo a"], ["b", "echo b"]]);
  assert.equal(stepsOf("echo a && echo b && echo c", checks), null, "a text no check has");
  assert.equal(stepsOf("echo a &&  echo b", checks), null, "a join spelled differently");
  assert.equal(stepsOf("echo a; echo b", checks), null);
  assert.equal(stepsOf("echo a && ", checks), null);
  assert.equal(stepsOf("", checks), null);
  assert.equal(stepsOf("echo a", []), null, "no checks file, no names");
});

test("steps: a check is matched whole — never a text that only begins it, and its own && stays inside it", () => {
  assert.equal(stepsOf("npx vitest run src/lib/help", checksOf([["web", "npx vitest run src/lib"]])), null);
  assert.equal(stepsOf("echo a && echo bc", checksOf([["a", "echo a"], ["b", "echo b"]])), null);
  const checks = checksOf([["build", "cd pkg && make"], ["test", "npm test"]]);
  assert.deepEqual(stepsOf("cd pkg && make && npm test", checks)?.map((s) => s.name), ["build", "test"]);
});

test("steps: two checks with the same text take the first name in the file", () => {
  const checks = checksOf([["first", "npm test"], ["second", "npm test"]]);
  assert.deepEqual(stepsOf("npm test && npm test", checks)?.map((s) => s.name), ["first", "first"]);
});

// ---------------------------------------------------------------------
// 2. The marked command says and ends exactly as the command as written

const CASES: Array<[string, string[]]> = [
  ["every check passes", ["echo one", "echo two >&2", "echo three"]],
  ["a check in the middle fails", ["echo one", "echo failing >&2; exit 3", "echo never"]],
  ["a variable set in one check is seen by the next: one shell", ["X=5", "echo \"x=$X\""]],
  ["a check with its own || and ;", ["false || echo rescued", "echo a; false", "echo never"]],
  ["a check that ends the shell with exit 0", ["echo first", "exit 0", "echo never"]],
  ["a check whose # swallows the rest", ["echo one # a comment", "echo never"]],
  ["a pipeline and a background job", ["printf 'b\\na\\n' | sort", "sleep 0.1 & wait", "echo done"]],
];

for (const [what, runs] of CASES) {
  test(`steps: marked and as written behave the same — ${what}`, () => {
    const steps = stepsFrom(runs);
    const plain = shell(runs.join(" && "));
    const dir = tmp("cdir-steps-test-");
    assert.deepEqual(shell(markedCommand(steps), dir), plain, "with markers written");
    assert.deepEqual(
      shell(markedCommand(steps), path.join(dir, "gone", "nowhere")),
      plain,
      "with markers that cannot be written: still the same, and not a word about it",
    );
  });
}

// A marker that cannot be written must not end the shell in any shell a
// check may run under: dash and ksh end a script when a redirection on the
// special built-in `:` fails (measured), which is why the marker is `true`.
const SHELLS = ["/bin/sh", "/bin/dash", "/bin/ksh", "/bin/bash", "/bin/zsh"].filter((sh) => fs.existsSync(sh));

test(`steps: a marker that cannot be written changes nothing in any shell here (${SHELLS.join(", ")})`, () => {
  const steps = stepsFrom(["echo one", "echo two >&2", "exit 3", "echo never"]);
  const nowhere = path.join(tmp("cdir-steps-test-"), "gone", "nowhere");
  for (const sh of SHELLS) {
    const plain = spawnSync(sh, ["-c", steps.map((s) => s.run).join(" && ")], { encoding: "utf8" });
    const marked = spawnSync(sh, ["-c", markedCommand(steps)], {
      encoding: "utf8",
      env: { ...process.env, [STEP_DIR_ENV]: nowhere },
    });
    assert.deepEqual([marked.stdout, marked.stderr, marked.status], [plain.stdout, plain.stderr, plain.status], sh);
  }
});

// ---------------------------------------------------------------------
// 3. Times and outcomes, read from the markers

function timesOf(runs: string[]) {
  const steps = stepsFrom(runs);
  const dir = tmp("cdir-steps-test-");
  const r = shell(markedCommand(steps), dir);
  return readStepTimes(dir, steps, { endedAtMs: Date.now(), exitCode: r.status, timedOut: false });
}

test("steps: each check's time comes from its markers, and the check the run ended in is named", () => {
  const passed = timesOf(["sleep 0.3", "true"]);
  assert.deepEqual(passed?.map((t) => t.outcome), ["passed", "passed"]);
  assert.ok((passed![0].durationMs ?? 0) >= 250, `the 0.3 s check took ${passed![0].durationMs} ms`);

  assert.deepEqual(timesOf(["true", "exit 4", "true"])?.map((t) => t.outcome), ["passed", "failed", "not-started"]);
  assert.deepEqual(timesOf(["true", "exit 0", "true"])?.map((t) => t.outcome), ["passed", "ended", "not-started"]);
});

test("steps: no markers, no times — nothing is guessed", () => {
  const steps = stepsFrom(["true"]);
  assert.equal(readStepTimes(path.join(tmp("cdir-steps-test-"), "gone"), steps, { endedAtMs: 0, exitCode: 0, timedOut: false }), undefined);
  assert.equal(readStepTimes(tmp("cdir-steps-test-"), steps, { endedAtMs: 0, exitCode: 0, timedOut: false }), undefined);
});

test("steps: durations and the times line read as a person would say them", () => {
  assert.deepEqual([0, 14_000, 65_000, 3_720_000].map(formatDuration), ["0s", "14s", "1m 05s", "1h 02m"]);
  assert.equal(
    stepTimesLine([
      { name: "prepare", startedAt: "x", durationMs: 14_000, outcome: "passed" },
      { name: "iphone", startedAt: "x", durationMs: 1_100_000, outcome: "failed" },
      { name: "mac-build", outcome: "not-started" },
    ]),
    "prepare 14s · iphone 18m 20s (failed) · mac-build (not run)",
  );
  assert.equal(END_MARK, "end");
});

// ---------------------------------------------------------------------
// 4. The verifyCommand item

function repoWithChecks(checks: string): string {
  const root = makeGitRepo({ "src/a.js": "export const a = 1;\n" });
  fs.mkdirSync(path.join(root, ".codedirector"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codedirector", "checks.yaml"), `schemaVersion: 1\nchecks:\n${checks}`);
  return root;
}

function lockFor(verifyCommand: string, verifyTimeoutMs = 30_000): VibeCheck {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id: "IL-0001",
    status: "active",
    utterance: "steps test",
    goal: "g",
    interpretation: "i",
    keep: [],
    deny: [],
    change: "c",
    budget: { files: [], symbols: [], maxFiles: 1, maxLines: 1 },
    accept: [],
    assumptions: [],
    verifyCommand,
    verifyTimeoutMs,
    createdAt: "2026-11-06T00:00:00.000Z",
    createdBy: "test",
  };
}

async function verifyItem(root: string, command: string, opts: { timeoutMs?: number; progressFd?: number } = {}): Promise<VerificationItem> {
  const index: RepoIndex = (await buildIndex(root)).index;
  const report = verifyWithBaseline(root, lockFor(command, opts.timeoutMs), null, undefined, index, {
    typecheck: false,
    ...(opts.progressFd !== undefined ? { progressFd: opts.progressFd } : {}),
  });
  return report.items.find((i) => i.source === "verify-command")!;
}

const THREE = `  first: echo one\n  second: sleep 0.2\n  third: echo three\n`;
const JOINED = "echo one && sleep 0.2 && echo three";

test("verify: a passing run of named checks is named by them, with each check's time", async () => {
  const item = await verifyItem(repoWithChecks(THREE), JOINED);
  assert.equal(item.verdict, "held", item.detail);
  assert.equal(item.subject, "verifyCommand · 3 checks: first, second, third");
  assert.match(item.detail, /^verifyCommand passed: 3 checks in \d+s$/);
  assert.equal(item.artifactRef, `sh -c ${JSON.stringify(JOINED)} → exit 0`, "the command as approved, once");
  assert.deepEqual(item.steps?.map((s) => [s.name, s.outcome]), [["first", "passed"], ["second", "passed"], ["third", "passed"]]);
  assert.ok((item.steps![1].durationMs ?? 0) >= 150, `second took ${item.steps![1].durationMs} ms`);
  assert.ok((item.durationMs ?? -1) >= item.steps![1].durationMs!, "the whole run is at least its longest check");
});

test("verify: a failing run names the check it failed in, and the checks after it did not run", async () => {
  const root = repoWithChecks(`  first: echo one\n  second: echo broken >&2; exit 3\n  third: echo three\n`);
  const item = await verifyItem(root, "echo one && echo broken >&2; exit 3 && echo three");
  assert.equal(item.verdict, "violated");
  assert.match(item.detail, /^verifyCommand failed \(exit 3\) in second \(check 2 of 3\) after \d+s — output: broken · one$/);
  assert.ok(!item.detail.includes("echo three"), "the command is not repeated in the detail");
  assert.deepEqual(item.steps?.map((s) => s.outcome), ["passed", "failed", "not-started"]);
});

test("verify: exit 0 with checks that never started is not a pass — it is unchecked, and names them", async () => {
  const root = repoWithChecks(`  first: echo one\n  quits: exit 0\n  third: echo three\n`);
  const item = await verifyItem(root, "echo one && exit 0 && echo three");
  assert.equal(item.verdict, "unchecked");
  assert.equal(
    item.reason,
    "verifyCommand exited 0, but 1 check never started: third — the shell ended in quits (check 2 of 3)",
  );
  assert.equal(declaredButUnrunnable([item]).length, 1, "a declared check that never ran keeps the lock from verified");
});

test("verify: a timeout names the check it stopped", async () => {
  const root = repoWithChecks(`  first: echo one\n  slow: sleep 5\n  third: echo three\n`);
  const item = await verifyItem(root, "echo one && sleep 5 && echo three", { timeoutMs: 1_000 });
  assert.equal(item.verdict, "unchecked");
  assert.equal(item.reason, "verifyCommand timed out after 1000ms, in slow (check 2 of 3)");
  assert.deepEqual(item.steps?.map((s) => s.outcome), ["passed", "stopped", "not-started"]);
});

test("verify: a verifyCommand that is not a join of checks reads exactly as before, and records its time", async () => {
  const item = await verifyItem(repoWithChecks(THREE), "echo one && echo extra");
  assert.equal(item.subject, "verifyCommand · echo one && echo extra");
  assert.equal(item.detail, "verifyCommand passed: echo one && echo extra");
  assert.equal(item.steps, undefined);
  assert.ok(typeof item.durationMs === "number");
});

test("verify: progress says when the run starts, as each check starts, and how it ended", async () => {
  const log = path.join(tmp("cdir-steps-progress-"), "progress.log");
  const fd = fs.openSync(log, "w");
  try {
    await verifyItem(repoWithChecks(THREE), JOINED, { progressFd: fd });
  } finally {
    fs.closeSync(fd);
  }
  const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => l.replace(/^cdir · \d\d:\d\d:\d\d · /, ""));
  assert.equal(lines[0], "verifyCommand started: 3 checks");
  assert.equal(lines[1], "check 1/3 first started");
  assert.match(lines[2], /^check 2\/3 second started \(first took \d+s\)$/);
  assert.match(lines[3], /^check 3\/3 third started \(second took \d+s\)$/);
  assert.match(lines[4], /^checks passed: 3 checks in \d+s$/);
  assert.equal(lines.length, 5, lines.join("\n"));
});

test("verify: without a progress descriptor nothing is printed — the MCP server's stdout stays clean", async () => {
  const script =
    `const { buildIndex } = require(${JSON.stringify(path.join(__dirname, "..", "src", "core", "builder.js"))});` +
    `const { verifyWithBaseline } = require(${JSON.stringify(path.join(__dirname, "..", "src", "verify", "verify.js"))});` +
    `const root = process.argv[1];` +
    `buildIndex(root).then(({ index }) => verifyWithBaseline(root, JSON.parse(process.argv[2]), null, undefined, index, { typecheck: false }));`;
  const r = spawnSync(NODE, ["-e", script, repoWithChecks(THREE), JSON.stringify(lockFor(JOINED))], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

// ---------------------------------------------------------------------
// 5. The report prints the long command once

test("report: a run of named checks prints its command once, and every check's time", async () => {
  const root = makeGitRepo({ "src/math.js": "export function add(a, b) { return a + b; }\n" });
  fs.mkdirSync(path.join(root, ".codedirector"), { recursive: true });
  const long = `${JSON.stringify(NODE)} -e ${JSON.stringify("process.exit(0) /* a long check command */")}`;
  fs.writeFileSync(
    path.join(root, ".codedirector", "checks.yaml"),
    `schemaVersion: 1\nchecks:\n  quick: echo quick\n  long: ${JSON.stringify(long)}\nareas:\n  - paths: [src]\n    need: [quick, long]\n`,
  );
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make add clearer", { now: "2026-11-06T00:00:00.000Z", createdBy: "test" });
  lock.keep = [];
  lock.budget = { files: ["src/math.js"], symbols: [], maxFiles: 1, maxLines: 10 };
  lock.verifyCommand = `echo quick && ${long}`;
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);

  const outcome = await runWithLock(root, lock.id, [NODE, "-e", `require("fs").appendFileSync("src/math.js", "// clearer\\n")`], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.record.violations));
  const report = await buildReport(root, lock.id, { verification: outcome.record.verification, run: outcome.record, runRecordPath: outcome.recordPath });

  for (const [format, text] of [["terminal", formatReport(report)], ["markdown", formatReportMarkdown(report)]] as const) {
    assert.equal(text.split("a long check command").length - 1, 1, `${format}: the command once, in the artifact\n${text}`);
    assert.match(text, /verifyCommand · 2 checks: quick, long/, format);
    assert.match(text, /times: quick \d+s · long \d+s/, format);
  }
});

// ---------------------------------------------------------------------
// 6. A failed check's result files name the tests its console did not

import { checksFromText } from "../src/config/checks";
import { DomainRegistry } from "../src/domain/registry";
import { XCRESULT_READER } from "../src/domains/apple/results";

/** A reader for ".fake" files: one failed test name per line; it logs each read. */
function fakeDomains(log: string): DomainRegistry {
  return new DomainRegistry([
    {
      id: "fake",
      description: "test results in .fake files",
      checkProviders: {
        resultReaders: [
          {
            suffix: ".fake",
            argv: (file) => ["/bin/sh", "-c", `echo read >> ${JSON.stringify(log)}; cat ${JSON.stringify(file)}`],
            failures: (output) => {
              const lines = output.split("\n").filter(Boolean);
              return { tests: lines.filter((l) => !l.startsWith("message:")), message: lines.find((l) => l.startsWith("message:"))?.slice(9) };
            },
          },
        ],
      },
    },
  ]);
}

async function verifyWithResults(failing: string, results: string, log: string): Promise<VerificationItem> {
  const root = repoWithChecks(`  first: echo one\n  tests:\n    run: ${JSON.stringify(failing)}\n    results: ${JSON.stringify(results)}\n`);
  const index: RepoIndex = (await buildIndex(root)).index;
  const report = verifyWithBaseline(root, lockFor(`echo one && ${failing}`), null, undefined, index, {
    typecheck: false,
    domains: fakeDomains(log),
  });
  return report.items.find((i) => i.source === "verify-command")!;
}

test("results: a failed check whose console named no test is read from the result file it wrote", async () => {
  const out = tmp("cdir-results-");
  const log = path.join(out, "reads.log");
  // An older run's file is not this run's: it must not be read.
  fs.writeFileSync(path.join(out, "old.fake"), "Stale/testFromYesterday()\n");
  const hourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(out, "old.fake"), hourAgo, hourAgo);

  const failing = `printf 'Alpha/testOne()\\nmessage: XCTUnwrap failed\\nBeta/testTwo()\\n' > ${out}/run.fake; echo Testing started; exit 65`;
  const item = await verifyWithResults(failing, `${out}/*.fake`, log);
  assert.equal(item.verdict, "violated");
  assert.match(
    item.detail,
    /^verifyCommand failed \(exit 65\) in tests \(check 2 of 2\) after \d+s — 2 failed tests \(from run\.fake\): Alpha\/testOne\(\), Beta\/testTwo\(\) — XCTUnwrap failed — output: /,
  );
  assert.deepEqual(item.failedTests, ["Alpha/testOne()", "Beta/testTwo()"]);
  assert.deepEqual(item.resultFiles, [path.join(out, "run.fake")]);
  assert.ok(!item.detail.includes("testFromYesterday"), "a file from before the check started is not read");
});

test("results: when the console names the failed test, the result files are not read at all", async () => {
  const out = tmp("cdir-results-");
  const log = path.join(out, "reads.log");
  const failing = `printf 'Gamma/testThree()\\n' > ${out}/run.fake; echo "Test Case '-[Mod.Gamma testThree]' failed (0.1 seconds)."; exit 65`;
  const item = await verifyWithResults(failing, `${out}/*.fake`, log);
  assert.match(item.detail, /— 1 failed test: Mod\.Gamma testThree — output: /);
  assert.equal(fs.existsSync(log), false, "no result file was read");
  assert.equal(item.resultFiles, undefined);
});

test("results: a check that wrote no result file says so, and the failure stands as before", async () => {
  const out = tmp("cdir-results-");
  const item = await verifyWithResults("echo nothing written; exit 65", `${out}/*.fake`, path.join(out, "reads.log"));
  assert.equal(item.verdict, "violated");
  assert.match(item.detail, new RegExp(`— results: no result file at ${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\*\\.fake written since the check started — output: one · nothing written$`));
});

test("results: checks.yaml takes `results` on a check, and only the last part of its path may hold *", () => {
  const ok = checksFromText(`schemaVersion: 1\nchecks:\n  t:\n    run: make test\n    results: /tmp/out/*.xcresult\n`);
  assert.equal(ok.status, "rules");
  assert.equal(ok.status === "rules" ? ok.rules.checks[0].results : undefined, "/tmp/out/*.xcresult");
  const bad = checksFromText(`schemaVersion: 1\nchecks:\n  t:\n    run: make test\n    results: /tmp/*/x.xcresult\n`);
  assert.equal(bad.status, "invalid");
  assert.match(bad.status === "invalid" ? bad.error : "", /only the last part of the path may hold \*/);
});

test("results: an Xcode summary names each failed test once, with the first message's first line", () => {
  const summary = JSON.stringify({
    result: "Failed",
    testFailures: [
      { testIdentifierString: "KallbergClockTests/testTheClockStops()", testName: "testTheClockStops()", failureText: "XCTUnwrap failed: expected non-nil value\nsecond line" },
      { testIdentifierString: "KallbergClockTests/testTheClockStops()", failureText: "again" },
      { testName: "testTheTrainWaits()", failureText: "" },
    ],
  });
  assert.deepEqual(XCRESULT_READER.failures(summary), {
    tests: ["KallbergClockTests/testTheClockStops()", "testTheTrainWaits()"],
    message: "XCTUnwrap failed: expected non-nil value",
  });
  assert.deepEqual(XCRESULT_READER.failures("not json"), { tests: [] });
  assert.ok(".x.xcresult".endsWith(XCRESULT_READER.suffix));
  assert.deepEqual(XCRESULT_READER.argv("/b.xcresult"), ["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", "/b.xcresult"]);
});

// ---------------------------------------------------------------------
// 7. `cdir run` does not print what its Change Report prints

import { formatRunReport } from "../src/run/run";

test("run: before its Change Report, a run leaves out the promises, files and violations the report lists — and keeps the way out", async () => {
  const root = makeGitRepo({ "src/math.js": "export function add(a, b) { return a + b; }\n", "src/other.js": "export const o = 1;\n" });
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make add clearer", { now: "2026-11-06T00:00:00.000Z", createdBy: "test" });
  lock.keep = [];
  lock.budget = { files: ["src/math.js"], symbols: [], maxFiles: 1, maxLines: 10 };
  lock.verifyCommand = "exit 3";
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", `require("fs").appendFileSync("src/other.js", "// out\\n")`], { stdio: "pipe" });
  assert.ok(outcome.record.violations.length >= 2, JSON.stringify(outcome.record.violations));

  const full = formatRunReport(outcome);
  const brief = formatRunReport(outcome, { brief: true });
  assert.ok(full.includes("VIOLATIONS (") && full.includes("changed files:"), full);
  assert.ok(!brief.includes("VIOLATIONS (") && !brief.includes("changed files:") && !brief.includes("KEEP:"), brief);
  assert.ok(brief.includes(`${outcome.record.violations.length} violation(s) — listed in the Change Report below.`), brief);
  for (const kept of ["command exited", "restore with `cdir undo`", "record: ", "cdir undo            restore the checkpoint", "--allow-expand"]) {
    assert.ok(brief.includes(kept), `brief keeps "${kept}"\n${brief}`);
  }
});
