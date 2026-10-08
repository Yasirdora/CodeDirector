/**
 * Check runs take turns (`turns` in .codedirector/checks.yaml): the lock's
 * verifyCommand waits for a shared turn, holds it while it runs, and lets go
 * of it on every path — including the one where cdir is killed.
 *
 * The turn here is a portable script made in the test: `mkdir` is the lock
 * (spin until it works), then run the rest, then give it back. The "other
 * check run" is another process using the same script, and the loader's own
 * cases (a bad `turns`) live in checks.test.ts.
 */

import assert from "node:assert/strict";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { RepoIndex } from "../src/core/types";
import { LOCK_SCHEMA_VERSION, VibeCheck } from "../src/lock/types";
import { declaredButUnrunnable, VerificationItem } from "../src/verify/types";
import { verifyWithBaseline } from "../src/verify/verify";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;

/** Takes the turn `$1` (a directory), runs the rest of the line, gives the turn back. Logs each taker. */
const TURN_SCRIPT = `dir="$1"; shift
until mkdir "$dir" 2>/dev/null; do sleep 0.1; done
echo taken >> "$dir.log"
"$@"
code=$?
rmdir "$dir"
exit $code
`;

/** The same verify as the tests run in-process, for the ones that need a process of their own. */
const WORKER = `const [builder, verify, root, lockJson] = process.argv.slice(2);
const { buildIndex } = require(builder);
const { verifyWithBaseline } = require(verify);
buildIndex(root).then(({ index }) => {
  const report = verifyWithBaseline(root, JSON.parse(lockJson), null, undefined, index, { typecheck: false });
  console.log(JSON.stringify(report.items.find((i) => i.source === "verify-command")));
});
`;

// ---------------------------------------------------------------------
// Helpers

interface Kit {
  dir: string;
  script: string;
  /** The directory the script uses as its lock: it exists while someone holds the turn. */
  held: string;
  /** The `turns` command prefix of this kit. */
  run: string;
  /** How many runs have taken the turn so far. */
  takers(): number;
}

function makeKit(): Kit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-turns-test-"));
  const script = path.join(dir, "turn.sh");
  const held = path.join(dir, "held");
  fs.writeFileSync(script, TURN_SCRIPT);
  fs.writeFileSync(path.join(dir, "worker.js"), WORKER);
  return {
    dir,
    script,
    held,
    run: `/bin/sh ${script} ${held}`,
    takers: () => {
      try {
        return fs.readFileSync(`${held}.log`, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    },
  };
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Wait for something another process does. The test thread sleeps in place, as the verifier does. */
function waitFor(done: () => boolean, what: string, ms = 15_000): void {
  const until = Date.now() + ms;
  while (!done()) {
    assert.ok(Date.now() < until, `timed out waiting for ${what}`);
    pause(50);
  }
}

/** A repo whose rules file asks for turns (or, with null, a repo with no rules file). */
function repoWith(turns: string | null): string {
  const root = makeGitRepo({ "src/a.js": "export const a = 1;\n" });
  if (turns !== null) {
    fs.mkdirSync(path.join(root, ".codedirector"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codedirector", "checks.yaml"), `schemaVersion: 1\n${turns}`);
  }
  return root;
}

/** The `turns` of a rules file in its long form. The wait is short, so a mistake fails fast, not in two hours. */
const turnsOf = (run: string, waitMs = 30_000): string => `turns:\n  run: ${JSON.stringify(run)}\n  waitMs: ${waitMs}\n`;

function lockFor(verifyCommand: string, verifyTimeoutMs = 30_000): VibeCheck {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id: "IL-0001",
    status: "active",
    utterance: "turns test",
    goal: "g",
    interpretation: "i",
    keep: [],
    deny: [],
    change: "c",
    budget: { files: [], symbols: [], maxFiles: 1, maxLines: 100 },
    accept: [],
    assumptions: [],
    createdAt: "2026-10-08T00:00:00.000Z",
    createdBy: "test",
    verifyCommand,
    verifyTimeoutMs,
  };
}

async function indexOf(root: string): Promise<RepoIndex> {
  return (await buildIndex(root)).index;
}

/** The verifyCommand's item. Synchronous, like the verifier itself. */
function verify(root: string, index: RepoIndex, verifyCommand: string, verifyTimeoutMs?: number): VerificationItem {
  const report = verifyWithBaseline(root, lockFor(verifyCommand, verifyTimeoutMs), null, undefined, index, { typecheck: false });
  return report.items.find((i) => i.source === "verify-command")!;
}

interface Running {
  child: ChildProcess;
  /** Resolves when the process has ended, with what it printed. */
  done: Promise<string>;
}

function run(command: string, args: string[]): Running {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  return { child, done: new Promise((resolve) => child.on("close", () => resolve(out))) };
}

/** Another check run, somewhere else, holding the turn for `seconds`. Returns once it has it. */
function holdElsewhere(kit: Kit, seconds: number): Running {
  const other = run("/bin/sh", [kit.script, kit.held, "sleep", String(seconds)]);
  waitFor(() => fs.existsSync(kit.held), "the other run to take the turn");
  return other;
}

/** A verify in a process of its own, as another agent's cdir would be. */
function verifyInAnotherProcess(kit: Kit, root: string, verifyCommand: string): Running {
  return run(NODE, [
    path.join(kit.dir, "worker.js"),
    path.join(__dirname, "..", "src", "core", "builder.js"),
    path.join(__dirname, "..", "src", "verify", "verify.js"),
    root,
    JSON.stringify(lockFor(verifyCommand)),
  ]);
}

/** Take the turn the way another run would, and say how long it took. */
function takeLikeAnother(kit: Kit): { status: number | null; ms: number } {
  const started = Date.now();
  const r = spawnSync("/bin/sh", [kit.script, kit.held, "true"], { timeout: 20_000 });
  return { status: r.status, ms: Date.now() - started };
}

/** Whatever of this kit is still running: a holder left behind would show here. */
function stillRunning(kit: Kit): string[] {
  const ps = spawnSync("ps", ["-Ao", "command", "-ww"], { encoding: "utf8" });
  return ps.stdout.split("\n").filter((line) => line.includes(kit.dir));
}

/** The holder ends within a second of the turn being let go; give it a few. */
function assertNothingLeftRunning(kit: Kit): void {
  waitFor(() => stillRunning(kit).length === 0, `nothing of ${kit.dir} to be left running`, 5_000);
}

const turnDirs = (): string[] => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("cdir-turn-"));

// ---------------------------------------------------------------------
// 1. Two check runs, one turn at a time

test("turns: two verifies started together, from two processes, never overlap", async () => {
  const kit = makeKit();
  const log = path.join(kit.dir, "windows.log");
  const record =
    `const fs=require("fs"),f=${JSON.stringify(log)};` +
    `fs.appendFileSync(f,"start "+Date.now()+"\\n");` +
    `setTimeout(()=>fs.appendFileSync(f,"end "+Date.now()+"\\n"),1000)`;
  const command = `${JSON.stringify(NODE)} -e ${JSON.stringify(record)}`;
  // Two worktrees of one project: two repos with the same rules.
  const rules = turnsOf(kit.run);

  const first = verifyInAnotherProcess(kit, repoWith(rules), command);
  const second = verifyInAnotherProcess(kit, repoWith(rules), command);
  const items = (await Promise.all([first.done, second.done])).map((out) => JSON.parse(out) as VerificationItem);

  assert.deepEqual(items.map((i) => i.verdict), ["held", "held"], JSON.stringify(items));
  const events = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" "));
  assert.deepEqual(events.map((e) => e[0]), ["start", "end", "start", "end"], "one window after the other");
  const times = events.map((e) => Number(e[1]));
  assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]), `times in order: ${times}`);
  assert.equal(kit.takers(), 2);
  assertNothingLeftRunning(kit);
});

// ---------------------------------------------------------------------
// 2. Waiting is not timed

test("turns: waiting for the turn does not count against the verify timeout, and the report says it waited", async () => {
  const kit = makeKit();
  const root = repoWith(turnsOf(kit.run));
  const index = await indexOf(root);

  const other = holdElsewhere(kit, 3);
  const started = Date.now();
  const item = verify(root, index, "echo quick", 2_000);
  assert.ok(Date.now() - started > 2_000, "the wait was longer than the verify timeout — the premise of this test");

  assert.equal(item.verdict, "held", item.detail);
  assert.match(item.detail, /^verifyCommand passed: echo quick \(waited \d+s for the turn\)$/);
  await other.done;
  assertNothingLeftRunning(kit);
});

test("turns: a turn that comes at once leaves the item as it always was", async () => {
  const kit = makeKit();
  const root = repoWith(turnsOf(kit.run));
  const item = verify(root, await indexOf(root), "echo quick");
  assert.equal(item.verdict, "held");
  assert.equal(item.detail, "verifyCommand passed: echo quick");
  assert.equal(kit.takers(), 1, "it did take a turn");
});

test("turns: a failing verifyCommand says it waited, too", async () => {
  const kit = makeKit();
  const root = repoWith(turnsOf(kit.run));
  const index = await indexOf(root);

  const other = holdElsewhere(kit, 3);
  const item = verify(root, index, "echo bad >&2; exit 3");
  assert.equal(item.verdict, "violated");
  assert.match(item.detail, /^verifyCommand failed \(exit 3\): echo bad >&2; exit 3 — output: bad \(waited \d+s for the turn\)$/);
  await other.done;
});

// ---------------------------------------------------------------------
// 3. The skip rule

test("turns: a verifyCommand that already takes the turn itself completes — it does not wait for itself", async () => {
  const kit = makeKit();
  // A short wait, so a deadlock fails as "no turn within 4s" instead of hanging.
  const root = repoWith(turnsOf(kit.run, 4_000));
  const index = await indexOf(root);

  const item = verify(root, index, `${kit.run} echo inside`, 3_000);
  assert.equal(item.verdict, "held", item.detail);
  assert.equal(item.detail, `verifyCommand passed: ${kit.run} echo inside`);
  assert.equal(kit.takers(), 1, "the command took the turn once, we did not take it again");

  // Whitespace does not hide it: the rule is the one the matching uses.
  const spaced = verify(root, index, kit.run.replace(/ /g, "   ") + "\n  echo inside", 3_000);
  assert.equal(spaced.verdict, "held", spaced.detail);
  assert.equal(kit.takers(), 2);
  assertNothingLeftRunning(kit);
});

// ---------------------------------------------------------------------
// 4. The turns command fails, or the turn does not come

test("turns: a turns command that fails at once is unchecked, with its exit code and what it said", async () => {
  const run = "sh -c 'echo the lock is broken >&2; exit 75' turns";
  const root = repoWith(turnsOf(run));
  const item = verify(root, await indexOf(root), "echo never runs");

  assert.equal(item.verdict, "unchecked");
  assert.equal(item.evidenceClass, "unchecked");
  assert.equal(item.reason, `could not take the turn: "${run}" exited 75: the lock is broken`);
  assert.equal(item.detail, item.reason);
  assert.equal(declaredButUnrunnable([item]).length, 1, "so the verdict is incomplete, as for a verify timeout");
});

test("turns: a turns command that fails without a word is unchecked with its exit code alone", async () => {
  const root = repoWith(turnsOf("false"));
  const item = verify(root, await indexOf(root), "echo never runs");
  assert.equal(item.verdict, "unchecked");
  assert.equal(item.reason, 'could not take the turn: "false" exited 1');
});

test("turns: when the wait runs out the item is unchecked, and the waiting is ended — it cannot take the turn later", async () => {
  const kit = makeKit();
  const root = repoWith(turnsOf(kit.run, 1_000));
  const index = await indexOf(root);

  const other = holdElsewhere(kit, 3);
  const item = verify(root, index, "echo never runs");
  assert.equal(item.verdict, "unchecked");
  assert.equal(item.reason, "no turn within 1s: another check run held it");
  assert.equal(declaredButUnrunnable([item]).length, 1);

  await other.done;
  // A waiter left alive would take the turn the moment the other let go.
  pause(1_000);
  assert.equal(kit.takers(), 1, "only the other run ever took the turn");
  assertNothingLeftRunning(kit);
});

// ---------------------------------------------------------------------
// 5. The turn is always let go of

test("turns: after a verify the turn is free within seconds, and nothing is left behind", async () => {
  const kit = makeKit();
  const root = repoWith(turnsOf(kit.run));
  const index = await indexOf(root);
  const dirsBefore = turnDirs();

  assert.equal(verify(root, index, "echo done").verdict, "held");
  assert.equal(kit.takers(), 1, "it did take a turn");
  const next = takeLikeAnother(kit);
  assert.equal(next.status, 0);
  assert.ok(next.ms < 5_000, `the next taker waited ${next.ms}ms`);
  assert.deepEqual(turnDirs(), dirsBefore, "the temporary files are gone");
  assertNothingLeftRunning(kit);
});

test("turns: the turn is let go of when the command fails or times out", async () => {
  const kit = makeKit();
  const root = repoWith(turnsOf(kit.run));
  const index = await indexOf(root);

  assert.equal(verify(root, index, "exit 1").verdict, "violated");
  assert.equal(kit.takers(), 1, "it did take a turn");
  assert.equal(takeLikeAnother(kit).status, 0);
  const slow = verify(root, index, "sleep 5", 200);
  assert.equal(slow.verdict, "unchecked");
  assert.ok(slow.reason!.includes("timed out after 200ms"), slow.reason);
  assert.equal(kit.takers(), 3, "and a turn again");
  const next = takeLikeAnother(kit);
  assert.equal(next.status, 0);
  assert.ok(next.ms < 5_000, `the next taker waited ${next.ms}ms`);
  assertNothingLeftRunning(kit);
});

test("turns: a cdir killed with SIGKILL while it holds the turn frees it within seconds", async () => {
  const kit = makeKit();
  const root = repoWith(turnsOf(kit.run));
  const pidFile = path.join(kit.dir, "command.pid");

  // The verifyCommand starts only once the turn is taken, so its pid file proves we hold it.
  const worker = verifyInAnotherProcess(kit, root, `echo $$ > ${pidFile}; exec sleep 8`);
  waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", "the verifyCommand to start");
  assert.ok(fs.existsSync(kit.held), "the worker holds the turn");

  worker.child.kill("SIGKILL");
  await worker.done;
  const next = takeLikeAnother(kit);
  assert.equal(next.status, 0);
  assert.ok(next.ms < 5_000, `the next taker waited ${next.ms}ms`);

  // The killed cdir could not stop its command; the test does, so nothing outlives it.
  try {
    process.kill(Number(fs.readFileSync(pidFile, "utf8")));
  } catch {
    // already ended
  }
  assertNothingLeftRunning(kit);
});

// ---------------------------------------------------------------------
// 6. Without turns, nothing changes

test("turns: without a rules file, without turns, or with a bad rules file, no turn is taken and the item is as before", async () => {
  const kit = makeKit();
  const dirsBefore = turnDirs();
  const repos = {
    "no rules file": repoWith(null),
    "no turns": repoWith("checks:\n  unit: echo unit\n"),
    "a bad rules file": repoWith("turns:\n  run: ''\n"),
  };
  for (const [what, root] of Object.entries(repos)) {
    const item = verify(root, await indexOf(root), "echo quick");
    assert.equal(item.verdict, "held", what);
    assert.equal(item.detail, "verifyCommand passed: echo quick", what);
    assert.equal(item.artifactRef, 'sh -c "echo quick" → exit 0', what);
  }
  assert.deepEqual(turnDirs(), dirsBefore, "no holder was made");
  assert.equal(kit.takers(), 0);
});
