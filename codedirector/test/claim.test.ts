/**
 * W1: one claim file per cdir root (`.codedirector/running.json`). A run or a
 * verify in progress is visible from another process, cannot be started
 * twice, and a claim whose process is gone is named stale — never deleted.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { sealLock } from "../src/lock/seal";
import { saveLock } from "../src/lock/store";
import { VibeCheck } from "../src/lock/types";
import { formatReport, formatReportMarkdown } from "../src/report/format";
import { buildReport } from "../src/report/report";
import { WASM_STARTUP_FLAGS } from "../src/core/wasm-flags";
import { ClaimError, claimPath, claimRoot, type ClaimFile } from "../src/run/claim";
import { RunError, runWithLock } from "../src/run/run";
import { makeDemoGitRepo } from "./helpers";

const NODE = process.execPath;
/** dist/src/cli.js once built — the compiled tests live in dist/test. */
const CLI = path.join(__dirname, "..", "src", "cli.js");
/**
 * How a child runs cdir as ONE process. Started without its startup flags,
 * cli.js relaunches itself with them (src/cli.ts): the pid we hold is then a
 * wrapper, and SIGKILL — which it cannot pass on — leaves the run going.
 */
const CDIR = [NODE, ...WASM_STARTUP_FLAGS, CLI];
/** dist/src/run/claim.js — what the racing children import. */
const CLAIM_MODULE = path.join(__dirname, "..", "src", "run", "claim.js");

const runningFile = (root: string) => path.join(root, ".codedirector", "running.json");
const staleDir = (root: string) => path.join(root, ".codedirector", "running-stale");
const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, ready: () => boolean, limit = 15000): Promise<void> {
  const start = performance.now();
  while (!ready()) {
    assert.ok(performance.now() - start < limit, `timed out after ${limit}ms waiting for ${what}`);
    await pause(20);
  }
}

async function setup(customize?: (lock: VibeCheck) => void): Promise<{ root: string; lock: VibeCheck }> {
  const root = makeDemoGitRepo();
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make the preview feel instant", {
    now: "2026-11-04T00:00:00.000Z",
    createdBy: "test",
  });
  lock.budget = { files: ["src/preview.ts", "src/slider.ts"], symbols: [], maxFiles: 2, maxLines: 400 };
  lock.deny = ["src/export.ts"];
  lock.change = "preview responsiveness during drag only";
  lock.goal = "input-to-paint under 50ms during drag";
  customize?.(lock);
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return { root, lock };
}

/** A second, independent lock in the same root. */
async function secondLock(root: string): Promise<VibeCheck> {
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make the slider smoother", {
    now: "2026-11-04T00:00:01.000Z",
    createdBy: "test",
  });
  lock.budget = { files: ["src/slider.ts"], symbols: [], maxFiles: 2, maxLines: 400 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return lock;
}

/** One argv as the shell string a verifyCommand is. */
function shell(argv: string[]): string {
  return argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
}

const appendTo = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

interface WaitingCheck {
  command: string;
  started: string;
  release: string;
  count: string;
}

/**
 * A verifyCommand that counts its runs, says it started, then waits for a
 * release marker (at most `waitMs`, so a forgotten release fails loudly).
 */
function waitingCheck(waitMs = 15000): WaitingCheck {
  const dir = tempDir("cdir-claim-check-");
  const started = path.join(dir, "started");
  const release = path.join(dir, "release");
  const count = path.join(dir, "runs");
  const script =
    `const fs=require("fs");` +
    `fs.appendFileSync(${JSON.stringify(count)},"ran\\n");` +
    `fs.writeFileSync(${JSON.stringify(started)},"started");` +
    `const until=Date.now()+${waitMs};` +
    `while(!fs.existsSync(${JSON.stringify(release)})){` +
    `if(Date.now()>until){process.stderr.write("release marker never came\\n");process.exit(3);}` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}`;
  return { command: shell([NODE, "-e", script]), started, release, count };
}

/** Runs recorded so far by the counting check. */
function checkRuns(file: string): number {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").length;
}

interface Running {
  child: ChildProcess;
  done: Promise<number | null>;
  text: () => string;
}

function spawnChild(t: TestContext, argv: string[], cwd: string): Running {
  const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
  const done = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { child, done, text: () => out };
}

/** Wait for the child, never longer than `limit`; kill it when it hangs. */
async function exitOf(run: Running, limit = 20000): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), limit);
  });
  const result = await Promise.race([run.done, late]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") {
    run.child.kill("SIGKILL");
    assert.fail(`child did not exit within ${limit}ms: ${run.text()}`);
  }
  return result;
}

/** A finished `node -e 0`: its pid is dead. */
function deadPid(): number {
  const dead = spawnSync(NODE, ["-e", "0"]);
  assert.equal(dead.status, 0, "the probe process must run");
  return dead.pid;
}

function writeClaim(root: string, fields: Partial<ClaimFile> & { lockId: string; pid: number }): void {
  const now = new Date().toISOString();
  const base: Omit<ClaimFile, "lockId" | "pid"> = {
    formatVersion: 1,
    kind: "run",
    attempt: 1,
    host: os.hostname(),
    processStartedAt: now,
    startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    command: [NODE, "-e", "0"],
    phase: "verifyCommand",
    phaseSince: now,
    cdirVersion: "test",
  };
  fs.mkdirSync(path.dirname(claimPath(root)), { recursive: true });
  fs.writeFileSync(claimPath(root), JSON.stringify({ ...base, ...fields } as ClaimFile));
}

test("claim: a run in another process is refused, followed and removed", { timeout: 90000 }, async (t) => {
  const check = waitingCheck();
  const { root, lock } = await setup((l) => {
    l.verifyCommand = check.command;
  });
  const other = await secondLock(root);

  const run = spawnChild(
    t,
    [...CDIR, "run", lock.id, "--root", root, "--", NODE, "-e", appendTo("src/preview.ts", "// child\n")],
    root,
  );
  await waitFor("the child's verifyCommand to start", () => fs.existsSync(check.started));
  const pid = run.child.pid;
  assert.ok(pid !== undefined, "the child has a pid");

  // (a) the same lock, from this process
  await assert.rejects(
    runWithLock(root, lock.id, [NODE, "-e", "1"], { stdio: "pipe" }),
    (e: unknown) => {
      assert.ok(e instanceof RunError, `expected a RunError, got ${String(e)}`);
      assert.match(e.message, new RegExp(`${lock.id} attempt 1 is running since \\d{2}:\\d{2} \\(pid ${pid}\\)`), e.message);
      assert.match(e.message, /now on verifyCommand since \d{2}:\d{2}/, e.message);
      assert.match(e.message, /cdir report/, e.message);
      assert.match(e.message, /do not start it again/, e.message);
      return true;
    },
  );
  assert.ok(fs.existsSync(runningFile(root)), "a refused run must not remove another process's claim");

  // (b) a different lock in the same root
  await assert.rejects(runWithLock(root, other.id, [NODE, "-e", "1"], { stdio: "pipe" }), (e: unknown) => {
    assert.ok(e instanceof RunError, `expected a RunError, got ${String(e)}`);
    assert.match(e.message, new RegExp(`pid ${pid}`), e.message);
    return true;
  });

  // (c) a report follows it and runs nothing
  const report = await buildReport(root, lock.id);
  assert.ok(report.running, "the report must carry what is running");
  assert.equal(report.running?.lockId, lock.id);
  assert.equal(report.running?.pid, pid);
  assert.equal(report.running?.phase, "verifyCommand");
  assert.equal(checkRuns(check.count), 1, "the report must not run the verifyCommand behind a live claim");
  assert.ok(formatReport(report).startsWith("Running now: "), formatReport(report).slice(0, 120));
  assert.ok(formatReportMarkdown(report).startsWith("Running now: "));

  // (d) lock show names it
  const shown = execFileSync(NODE, [CLI, "lock", "show", lock.id, "--root", root], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(shown, /running since /);
  assert.match(shown, new RegExp(`pid ${pid}`));

  // Release: the child finishes, and its claim goes with it.
  fs.writeFileSync(check.release, "go");
  assert.equal(await exitOf(run), 0, run.text());
  assert.equal(fs.existsSync(runningFile(root)), false, "the claim is removed when the run ends");
  const after = await buildReport(root, lock.id);
  assert.equal(after.running, undefined);
});

test("claim: a claim whose process is dead is set aside as stale, kept, and does not block", { timeout: 40000 }, async () => {
  const { root, lock } = await setup();
  const pid = deadPid();
  writeClaim(root, { lockId: lock.id, pid });

  const outcome = await runWithLock(root, lock.id, [NODE, "-e", "0"], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  const note = outcome.record.staleClaim ?? "";
  assert.match(note, new RegExp(`found a stale claim from ${lock.id} \\(pid ${pid}, since`), note);
  assert.ok(note.includes(".codedirector/running-stale/"), note);
  assert.equal(fs.readdirSync(staleDir(root)).length, 1, "the stale claim is kept, not deleted");
  assert.equal(fs.existsSync(runningFile(root)), false);
});

test("claim: this pid with an hour-old start time is stale (a reused pid)", { timeout: 30000 }, async () => {
  const { root, lock } = await setup();
  writeClaim(root, {
    lockId: lock.id,
    pid: process.pid,
    processStartedAt: new Date(Date.now() - 3600_000).toISOString(),
  });
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", "0"], { stdio: "pipe" });
  assert.match(outcome.record.staleClaim ?? "", new RegExp(`found a stale claim from ${lock.id} \\(pid ${process.pid}`));
  assert.equal(fs.readdirSync(staleDir(root)).length, 1);
  assert.equal(fs.existsSync(runningFile(root)), false);
});

test("claim: a run killed during its verifyCommand leaves a claim the next run calls stale", { timeout: 90000 }, async (t) => {
  const check = waitingCheck(5000);
  const { root, lock } = await setup((l) => {
    l.verifyCommand = check.command;
  });
  const run = spawnChild(
    t,
    [...CDIR, "run", lock.id, "--root", root, "--no-report", "--", NODE, "-e", appendTo("src/preview.ts", "// killed\n")],
    root,
  );
  await waitFor("the killed run's verifyCommand to start", () => fs.existsSync(check.started));
  run.child.kill("SIGKILL");
  await exitOf(run);
  assert.ok(fs.existsSync(runningFile(root)), "a killed run leaves its claim behind");

  const outcome = await runWithLock(root, lock.id, [NODE, "-e", "0"], { stdio: "pipe", verify: false });
  assert.match(outcome.record.staleClaim ?? "", new RegExp(`found a stale claim from ${lock.id}`));
  assert.equal(fs.existsSync(runningFile(root)), false);
});

test("claim: two processes racing for the claim — exactly one wins", { timeout: 40000 }, async (t) => {
  const { root, lock } = await setup();
  const dir = tempDir("cdir-claim-race-");
  const scriptPath = path.join(dir, "claim.js");
  const script = [
    'const fs = require("fs");',
    "const [root, lockId, ready, go] = process.argv.slice(2);",
    `const { claimRoot } = require(${JSON.stringify(CLAIM_MODULE)});`,
    'fs.writeFileSync(ready, "1");',
    "const until = Date.now() + 10000;",
    'while (!fs.existsSync(go)) { if (Date.now() > until) process.exit(9); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }',
    "try {",
    '  const claim = claimRoot(root, { kind: "run", lockId, command: ["node", "-e", "0"], phase: "command" });',
    '  process.stdout.write("won\\n");',
    "  setTimeout(() => claim.release(), 4000);",
    "} catch (e) {",
    '  process.stdout.write("refused: " + e.message + "\\n");',
    "}",
  ].join("\n");
  fs.writeFileSync(scriptPath, script);

  const racer = (tag: string) =>
    spawnChild(t, [NODE, scriptPath, root, lock.id, path.join(dir, `ready-${tag}`), path.join(dir, "go")], root);
  const a = racer("a");
  const b = racer("b");
  await waitFor("both racers ready", () => fs.existsSync(path.join(dir, "ready-a")) && fs.existsSync(path.join(dir, "ready-b")));
  fs.writeFileSync(path.join(dir, "go"), "go");
  assert.equal(await exitOf(a), 0, a.text());
  assert.equal(await exitOf(b), 0, b.text());

  const lines = `${a.text()}\n${b.text()}`.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.filter((l) => l === "won").length, 1, lines.join(" | "));
  const refused = lines.filter((l) => l.startsWith("refused:"));
  assert.equal(refused.length, 1, lines.join(" | "));
  assert.match(refused[0], new RegExp(`${lock.id} attempt 1 is running since`), refused[0]);
  assert.match(refused[0], /do not start it again/, refused[0]);
});

test("claim: a run removes its own claim when it finishes, and when it fails", { timeout: 60000 }, async () => {
  const { root, lock } = await setup();
  const seen = path.join(tempDir("cdir-claim-seen-"), "seen");
  const command = (code: number) => [
    NODE,
    "-e",
    `require("fs").writeFileSync(${JSON.stringify(seen)},String(require("fs").existsSync(${JSON.stringify(runningFile(root))})));` +
      `process.exit(${code})`,
  ];

  const ok = await runWithLock(root, lock.id, command(0), { stdio: "pipe" });
  assert.equal(ok.exitCode, 0, ok.record.violations.join("; "));
  assert.equal(fs.readFileSync(seen, "utf8"), "true", "the run holds a claim while its command runs");
  assert.equal(fs.existsSync(runningFile(root)), false, "a finished run removes its claim");

  const bad = await runWithLock(root, lock.id, command(1), { stdio: "pipe" });
  assert.equal(bad.record.exitCode, 1);
  assert.equal(fs.existsSync(runningFile(root)), false, "a failed run removes its claim");
});

test("claim: after another process takes our place, release leaves its claim and this process is refused, not let in", () => {
  const root = tempDir("cdir-claim-takeover-");
  const mine = claimRoot(root, { kind: "run", lockId: "IL-0001", command: [NODE, "-e", "0"] });
  // Another live process now holds the file (here: our parent, with its real start time).
  const started = execFileSync("ps", ["-o", "lstart=", "-p", String(process.ppid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  writeClaim(root, { lockId: "IL-0002", pid: process.ppid, processStartedAt: new Date(started.trim()).toISOString() });
  mine.release();
  assert.ok(fs.existsSync(runningFile(root)), "the other process's claim stays");
  assert.throws(
    () => claimRoot(root, { kind: "run", lockId: "IL-0001", command: [NODE, "-e", "0"] }),
    (e: unknown) => e instanceof ClaimError && /IL-0002/.test(e.message),
  );
  const left = fs.readdirSync(path.join(root, ".codedirector")).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(left, [], "publishing a claim leaves no temporary file");
});

test("claim: a run that throws after claiming still releases its claim", { timeout: 30000 }, async () => {
  // A root without git: the checkpoint — the first work after the claim — throws.
  const root = tempDir("cdir-claim-nogit-");
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "keep a as it is", { now: "2026-11-04T00:00:02.000Z", createdBy: "test" });
  lock.budget = { files: ["a.txt"], symbols: [], maxFiles: 1, maxLines: 10 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);

  // A stale claim proves the run got as far as taking one before it threw.
  writeClaim(root, { lockId: lock.id, pid: deadPid() });

  await assert.rejects(runWithLock(root, lock.id, [NODE, "-e", "0"], { stdio: "pipe" }), /not a git repository/);
  assert.equal(fs.existsSync(runningFile(root)), false, "a run that throws removes its claim");
  assert.equal(fs.readdirSync(staleDir(root)).length, 1, "it had claimed: the stale file was set aside first");
});
