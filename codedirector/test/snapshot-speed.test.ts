/**
 * Every probe runs inside a snapshot of the work tree, put back after it.
 * The snapshot asks git for the project's place in the repo once: asked per
 * file, it cost a git process each — 33 s for one snapshot of a 2,943-file
 * app, against 0.02 s for git's own listing. And a verifyCommand's clock
 * starts with the command, after the snapshot, so the time it reports is
 * the command's own.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { RepoIndex } from "../src/core/types";
import { LOCK_SCHEMA_VERSION, VibeCheck } from "../src/lock/types";
import { runIsolated, snapshotWorkTree } from "../src/run/tree";
import { VerificationItem } from "../src/verify/types";
import { verifyWithBaseline } from "../src/verify/verify";
import { git, makeGitRepo, makeSubfolderDemoGitRepo } from "./helpers";

const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/**
 * Runs `fn` with a `git` first on PATH that writes down each call, then runs
 * the real git. With `slowListingSeconds`, every `git ls-files` waits that
 * long first — a stand-in for a big tree.
 */
function withCountedGit<T>(fn: () => T, slowListingSeconds = 0): { result: T; calls: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-gitshim-"));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(log, "");
  fs.writeFileSync(
    path.join(dir, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n` +
      (slowListingSeconds > 0 ? `if [ "$1" = ls-files ]; then sleep ${slowListingSeconds}; fi\n` : "") +
      `exec '${REAL_GIT}' "$@"\n`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before ?? ""}`;
  try {
    const result = fn();
    return { result, calls: fs.readFileSync(log, "utf8").split("\n").filter(Boolean) };
  } finally {
    process.env.PATH = before;
  }
}

const manyFiles = (n: number, dir = "src"): Record<string, string> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/f${i}.txt`, `file ${i}\n`]));

const prefixAsks = (calls: string[]): number => calls.filter((c) => c.startsWith("rev-parse --show-prefix")).length;

// ---------------------------------------------------------------------
// 1. The snapshot's cost does not grow with git processes per file

test("snapshot: the project's place in the repo is asked for once, however many files there are", () => {
  const root = makeGitRepo(manyFiles(150));
  const { result: snap, calls } = withCountedGit(() => snapshotWorkTree(root));
  assert.equal(Object.keys(snap.hashes).length, 150, "every tracked file is still hashed");
  assert.equal(prefixAsks(calls), 1, calls.join("\n"));
  assert.ok(calls.length <= 5, `${calls.length} git processes for one snapshot:\n${calls.join("\n")}`);
});

test("snapshot and put-back of a project in a subfolder of its repo: one prefix each, not one per file", () => {
  const sub = makeSubfolderDemoGitRepo();
  for (const [rel, text] of Object.entries(manyFiles(150))) {
    fs.mkdirSync(path.dirname(path.join(sub, rel)), { recursive: true });
    fs.writeFileSync(path.join(sub, rel), text);
  }
  git(sub, ["add", "-A"]);
  git(sub, ["commit", "-qm", "more"]);
  const { calls } = withCountedGit(() => runIsolated(sub, () => undefined));
  assert.equal(prefixAsks(calls), 2, `one for the snapshot, one for the put-back:\n${calls.join("\n")}`);
});

// ---------------------------------------------------------------------
// 2. What the prefix is used for still lands where it should

test("runIsolated in a subfolder project: a dirty file and an untracked file round-trip, a new file is removed", () => {
  const sub = makeSubfolderDemoGitRepo();
  fs.writeFileSync(path.join(sub, "src", "w14.txt"), "base\n");
  git(sub, ["add", "-A"]);
  git(sub, ["commit", "-qm", "w14"]);
  fs.writeFileSync(path.join(sub, "src", "w14.txt"), "dirty before the probe\n");
  fs.writeFileSync(path.join(sub, "notes.txt"), "mine\n");

  let seen: { restored: string[]; removed: string[] } | undefined;
  runIsolated(
    sub,
    () => {
      fs.writeFileSync(path.join(sub, "src", "w14.txt"), "the probe's\n");
      fs.writeFileSync(path.join(sub, "notes.txt"), "the probe's\n");
      fs.writeFileSync(path.join(sub, "new.txt"), "made by the probe\n");
    },
    (p) => (seen = p),
  );

  assert.equal(fs.readFileSync(path.join(sub, "src", "w14.txt"), "utf8"), "dirty before the probe\n");
  assert.equal(fs.readFileSync(path.join(sub, "notes.txt"), "utf8"), "mine\n");
  assert.ok(!fs.existsSync(path.join(sub, "new.txt")), "the probe's new file is removed");
  assert.deepEqual(seen?.restored, ["sub/notes.txt", "sub/src/w14.txt"]);
  assert.deepEqual(seen?.removed, ["sub/new.txt"]);
});

// ---------------------------------------------------------------------
// 3. The verifyCommand's time is the command's

function lockFor(verifyCommand: string): VibeCheck {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id: "IL-0001",
    status: "active",
    utterance: "snapshot test",
    goal: "g",
    interpretation: "i",
    keep: [],
    deny: [],
    change: "c",
    budget: { files: [], symbols: [], maxFiles: 1, maxLines: 1 },
    accept: [],
    assumptions: [],
    verifyCommand,
    verifyTimeoutMs: 30_000,
    createdAt: "2026-11-06T00:00:00.000Z",
    createdBy: "test",
  };
}

async function verifyWithSlowSnapshot(root: string, command: string, progressFd?: number): Promise<VerificationItem> {
  const index: RepoIndex = (await buildIndex(root)).index;
  const { result } = withCountedGit(
    () =>
      verifyWithBaseline(root, lockFor(command), null, undefined, index, {
        typecheck: false,
        ...(progressFd !== undefined ? { progressFd } : {}),
      }),
    2,
  );
  return result.items.find((i) => i.source === "verify-command")!;
}

test("verify: the command's time starts after the tree is snapshotted — a slow snapshot is not the command's", async () => {
  const item = await verifyWithSlowSnapshot(makeGitRepo({ "src/a.js": "export const a = 1;\n" }), "echo one");
  assert.equal(item.verdict, "held", item.detail);
  // The snapshot lists the tree twice (tracked files, hidden files), each
  // made to take 2 s here: 4 s or more before the command can start.
  assert.ok((item.durationMs ?? Infinity) < 3_000, `the command took ${item.durationMs} ms by the record`);
});

test("verify: the progress line and the report give a run of named checks the same total", async () => {
  const root = makeGitRepo({ "src/a.js": "export const a = 1;\n" });
  fs.mkdirSync(path.join(root, ".codedirector"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codedirector", "checks.yaml"), "schemaVersion: 1\nchecks:\n  first: echo one\n  second: sleep 1.2\n");
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdir-snap-progress-")), "progress.log");
  const fd = fs.openSync(log, "w");
  let item: VerificationItem;
  try {
    item = await verifyWithSlowSnapshot(root, "echo one && sleep 1.2", fd);
  } finally {
    fs.closeSync(fd);
  }
  const passed = fs.readFileSync(log, "utf8").trim().split("\n").pop() ?? "";
  const said = /checks passed: 2 checks in (.+)$/.exec(passed)?.[1];
  const reported = /^verifyCommand passed: 2 checks in (.+)$/.exec(item.detail)?.[1];
  assert.ok(said !== undefined && reported !== undefined, `${passed}\n${item.detail}`);
  assert.equal(said, reported);
});
