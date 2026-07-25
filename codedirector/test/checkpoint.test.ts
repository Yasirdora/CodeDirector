/**
 * Checkpoint / undo tests in temp git repos.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import {
  CheckpointError,
  createCheckpoint,
  latestCheckpoint,
  undo,
} from "../src/checkpoint";
import { git, makeGitRepo } from "./helpers";

test("checkpoint/undo round-trip restores a modified tracked file", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  const ckpt = createCheckpoint(root);
  assert.equal(ckpt.dirty, false);
  assert.equal(latestCheckpoint(root)?.id, ckpt.id);

  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 2;\n");
  const result = undo(root);
  assert.equal(result.checkpoint.id, ckpt.id);
  assert.equal(result.forced, false);
  assert.deepEqual(result.lostFiles, ["src/a.ts"]);
  assert.equal(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const v = 1;\n");
});

test(".codedirector tool state does not count as a dirty tree", () => {
  const root = makeGitRepo();
  fs.mkdirSync(path.join(root, ".codedirector", "locks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codedirector", "locks", "IL-0001-x.yaml"), "id: x\n");
  const ckpt = createCheckpoint(root);
  assert.equal(ckpt.dirty, false, "untracked .codedirector state ignored");
});

test("undo refuses over a checkpoint taken with a dirty tree, unless --force", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  // dirty the tree BEFORE the checkpoint
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 2;\n");
  const ckpt = createCheckpoint(root);
  assert.equal(ckpt.dirty, true);

  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 3;\n");
  assert.throws(() => undo(root), CheckpointError, "dirty checkpoint refuses without --force");
  try {
    undo(root);
  } catch (e) {
    assert.ok(e instanceof CheckpointError);
    assert.ok(e.message.includes("src/a.ts"), "refusal names what will be lost");
    assert.ok(e.message.includes("--force"));
  }
  // file untouched by the refused undo
  assert.equal(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const v = 3;\n");

  const result = undo(root, { force: true });
  assert.equal(result.forced, true);
  assert.equal(
    fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"),
    "export const v = 2;\n",
    "force-undo restores checkpoint-time dirty bytes, not merely HEAD",
  );
});

test("undo reports untracked files left behind and logs every undo", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  createCheckpoint(root);
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 2;\n");
  fs.writeFileSync(path.join(root, "new.ts"), "export const n = 0;\n");
  const result = undo(root);
  assert.equal(fs.existsSync(path.join(root, "new.ts")), false, "undo removes untracked files created after the checkpoint");
  assert.ok(!result.untrackedRemaining.includes("new.ts"));

  const store = JSON.parse(
    fs.readFileSync(path.join(root, ".codedirector", "checkpoints.json"), "utf8"),
  );
  assert.equal(store.undos.length, 1, "undo logged");
  assert.equal(store.undos[0].forced, false);
});

test("checkpoint requires a git repo and a commit", () => {
  const root = makeGitRepo();
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  assert.throws(() => createCheckpoint(root), /not a git repository/);

  const empty = makeGitRepo();
  git(empty, ["rm", "-rq", "--cached", "."]);
  fs.rmSync(path.join(empty, ".git"), { recursive: true, force: true });
  git(empty, ["init", "-q"]);
  assert.throws(() => createCheckpoint(empty), /no commits yet/);
});

test("undo with no checkpoints fails cleanly", () => {
  const root = makeGitRepo();
  assert.throws(() => undo(root), /no checkpoint recorded/);
});

test("undo --keep-untracked preserves post-checkpoint untracked files", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  createCheckpoint(root);
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const v = 2;\n");
  fs.writeFileSync(path.join(root, "new.ts"), "export const n = 0;\n");
  const result = undo(root, { keepUntracked: true });
  assert.equal(fs.existsSync(path.join(root, "new.ts")), true, "kept");
  assert.equal(fs.readFileSync(path.join(root, "new.ts"), "utf8"), "export const n = 0;\n");
  assert.deepEqual(result.deletedUntracked, []);
  assert.ok(result.untrackedRemaining.includes("new.ts"));
  assert.equal(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const v = 1;\n");
});

test("undo without --keep-untracked reports the deleted untracked files", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  createCheckpoint(root);
  fs.writeFileSync(path.join(root, "new.ts"), "export const n = 0;\n");
  const result = undo(root);
  assert.deepEqual(result.deletedUntracked, ["new.ts"]);
  assert.equal(fs.existsSync(path.join(root, "new.ts")), false);
});
