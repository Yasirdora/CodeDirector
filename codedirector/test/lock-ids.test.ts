/**
 * Lock ids are unique across every worktree of a clone: the reservations
 * live in the git common dir, so a number handed out in one worktree is
 * taken in all of them. Outside git, ids are reserved in the locks folder.
 *
 * Every test makes its own repos in temp dirs. None of them touches the
 * repo this suite runs in.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { listLocks, locksDir, nextLockId, saveLock } from "../src/lock/store";
import { LOCK_SCHEMA_VERSION, VibeCheck } from "../src/lock/types";
import { copyFixture, git, makeGitRepo, makeSubfolderDemoGitRepo } from "./helpers";

/** A repo and a second, linked worktree of it — each with its own .codedirector. */
function twoWorktrees(): { main: string; linked: string } {
  const main = makeGitRepo({ "src/a.ts": "export const a = 1;\n" });
  const linked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdir-ids-")), "linked");
  git(main, ["worktree", "add", "--detach", linked, "HEAD"]);
  return { main, linked };
}

/** Where a clone keeps the ids it handed out. */
function reservationsOf(main: string): string {
  return path.join(main, ".git", "cdir", "lock-ids");
}

/** Draft a lock the way `cdir lock new` does and return its id. */
async function draftIn(root: string): Promise<string> {
  const { index } = await buildIndex(root);
  return draftLock(root, index, "touch the a module", { now: "2026-10-08T00:00:00.000Z", createdBy: "test" }).lock.id;
}

/** A lock with nothing in it but its id, as a numbering placeholder would be. */
function plainLock(id: string): VibeCheck {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id,
    status: "draft",
    utterance: `numbering placeholder ${id}`,
    goal: "g",
    interpretation: "i",
    keep: [],
    deny: [],
    change: "c",
    budget: { files: [], symbols: [], maxFiles: 1, maxLines: 400 },
    accept: [],
    assumptions: [],
    createdAt: "2026-10-08T00:00:00.000Z",
    createdBy: "test",
  };
}

function reserveFiles(root: string): string[] {
  return fs.readdirSync(locksDir(root)).filter((f) => f.startsWith(".reserve-"));
}

test("lock ids: a second worktree gets the next number, not its own folder's next", async () => {
  const { main, linked } = twoWorktrees();
  const first = await draftIn(main);
  assert.equal(first, "IL-0001");
  assert.equal(await draftIn(main), "IL-0002");
  assert.equal(await draftIn(main), "IL-0003");

  const fromLinked = await draftIn(linked);
  assert.equal(fromLinked, "IL-0004", "the linked folder had no locks, the clone had handed out three");
  assert.deepEqual(listLocks(linked).map((l) => l.id), ["IL-0004"]);
  assert.equal(await draftIn(main), "IL-0005", "and the main one counts the linked one's id");

  assert.deepEqual(
    fs.readdirSync(reservationsOf(main)).sort(),
    ["IL-0001", "IL-0002", "IL-0003", "IL-0004", "IL-0005"],
    "a reservation is never deleted, even once its lock file is written",
  );
});

test("lock ids: a high placeholder in one worktree moves the whole clone past it", async () => {
  const { main, linked } = twoWorktrees();
  saveLock(main, plainLock("IL-0599"));
  assert.equal(await draftIn(main), "IL-0600");
  assert.equal(await draftIn(linked), "IL-0601", "the other worktree has no IL-0599 file and still starts above it");
  assert.equal(await draftIn(main), "IL-0602");
});

test("lock ids: processes in two worktrees drafting at once never share an id", async () => {
  const { main, linked } = twoWorktrees();
  const storeJs = path.join(__dirname, "..", "src", "lock", "store.js");
  const script =
    `const { nextLockId, saveLock } = require(${JSON.stringify(storeJs)});` +
    `const root = process.argv[1];` +
    `for (let i = 0; i < 3; i++) {` +
    `  const id = nextLockId(root);` +
    `  saveLock(root, { schemaVersion: 1, id, status: "draft", utterance: "child " + process.pid + "-" + i,` +
    `    goal: "g", interpretation: "i", keep: [], deny: [], change: "c",` +
    `    budget: { files: [], symbols: [], maxFiles: 1, maxLines: 400 }, accept: [], assumptions: [],` +
    `    createdAt: new Date().toISOString(), createdBy: "test" });` +
    `  console.log(id);` +
    `}`;
  const child = (root: string) =>
    new Promise<string[]>((resolve, reject) => {
      const proc = spawn(process.execPath, ["-e", script, root], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (err += d));
      proc.on("close", (code) =>
        code === 0 ? resolve(out.split("\n").filter(Boolean)) : reject(new Error(`child exited ${code}: ${err}`)),
      );
    });
  const [a1, a2, b1, b2] = await Promise.all([child(main), child(main), child(linked), child(linked)]);
  const ids = [...a1, ...a2, ...b1, ...b2];
  assert.equal(ids.length, 12, "three ids from each of four processes");
  assert.deepEqual(
    [...ids].sort(),
    Array.from({ length: 12 }, (_, i) => `IL-${String(i + 1).padStart(4, "0")}`),
    `every number handed out once and none skipped: ${ids.join(", ")}`,
  );
  assert.deepEqual(
    listLocks(main).map((l) => l.id).concat(listLocks(linked).map((l) => l.id)).sort(),
    [...ids].sort(),
    "each id has its lock file in the worktree that drafted it",
  );
});

test("lock ids: outside git, the reservation is a file in the locks folder, as before", () => {
  const root = copyFixture();
  assert.equal(nextLockId(root), "IL-0001");
  assert.deepEqual(reserveFiles(root), [".reserve-IL-0001"]);
  assert.equal(nextLockId(root), "IL-0002", "a held reservation is skipped");

  saveLock(root, plainLock("IL-0001"));
  assert.deepEqual(reserveFiles(root), [".reserve-IL-0002"], "saving the lock releases its reservation");
  assert.equal(fs.existsSync(path.join(root, ".git")), false, "nothing was made outside the locks folder");
});

test("lock ids: they order by number, so IL-10000 comes after IL-9999", () => {
  for (const [label, root] of [
    ["in git", makeGitRepo()],
    ["outside git", copyFixture()],
  ] as const) {
    saveLock(root, plainLock("IL-10000"));
    saveLock(root, plainLock("IL-9999"));
    assert.deepEqual(listLocks(root).map((l) => l.id), ["IL-9999", "IL-10000"], label);
    assert.equal(nextLockId(root), "IL-10001", label);
    assert.equal(nextLockId(root), "IL-10002", label);
  }
});

test("lock ids: the reservations are in the common dir, and no worktree sees a new file", () => {
  const { main, linked } = twoWorktrees();
  const ids = [nextLockId(main), nextLockId(linked), nextLockId(main)];
  assert.deepEqual(ids, ["IL-0001", "IL-0002", "IL-0003"]);

  assert.deepEqual(fs.readdirSync(reservationsOf(main)).sort(), ids);
  for (const id of ids) assert.equal(fs.statSync(path.join(reservationsOf(main), id)).size, 0, `${id} is an empty file`);
  for (const root of [main, linked]) {
    assert.equal(fs.existsSync(path.join(root, "cdir")), false, "no reservation folder in the worktree");
    assert.deepEqual(reserveFiles(root), [], "no local reservation either");
    assert.equal(git(root, ["status", "--porcelain"]), "", `git status of ${root} is clean`);
  }
});

test("lock ids: a project in a subfolder of the repo uses the repo's common dir", () => {
  const sub = makeSubfolderDemoGitRepo();
  assert.equal(nextLockId(sub), "IL-0001");
  assert.deepEqual(fs.readdirSync(reservationsOf(path.dirname(sub))), ["IL-0001"]);
  assert.deepEqual(reserveFiles(sub), []);
});

test("lock ids: when the common dir cannot be written, the local reservation is used", () => {
  // The folder's place is taken by a file, so it cannot be made.
  const blocked = makeGitRepo();
  fs.writeFileSync(path.join(blocked, ".git", "cdir"), "in the way");
  assert.equal(nextLockId(blocked), "IL-0001");
  assert.deepEqual(reserveFiles(blocked), [".reserve-IL-0001"]);

  // The folder exists but refuses new files. (Root can write anywhere.)
  const readOnly = makeGitRepo();
  fs.mkdirSync(reservationsOf(readOnly), { recursive: true });
  if (process.getuid?.() !== 0) {
    fs.chmodSync(reservationsOf(readOnly), 0o555);
    try {
      assert.equal(nextLockId(readOnly), "IL-0001");
      assert.deepEqual(reserveFiles(readOnly), [".reserve-IL-0001"]);
      assert.deepEqual(fs.readdirSync(reservationsOf(readOnly)), []);
    } finally {
      fs.chmodSync(reservationsOf(readOnly), 0o755);
    }
  }
});
