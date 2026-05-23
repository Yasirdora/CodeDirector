import assert from "node:assert";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addTask, listTasks } from "../src/tasks.ts";
import { loadTasks, nextId } from "../src/storage.ts";

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "tasks-test-")), "tasks.json");
}

test("add + list shows newest first", () => {
  const f = tmpFile();
  addTask("first", f);
  addTask("second", f);
  const list = listTasks(false, f);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].title, "second");
  assert.strictEqual(list[1].title, "first");
});

test("nextId increments past max id", () => {
  assert.strictEqual(nextId([]), 1);
  assert.strictEqual(nextId([{ id: 3, title: "x", done: false, createdAt: "" }]), 4);
});

test("done tasks are hidden from default list", async () => {
  const f = tmpFile();
  addTask("keep", f);
  const t2 = addTask("hide me", f);
  const tasks = loadTasks(f);
  tasks.find((t) => t.id === t2.id)!.done = true;
  const { saveTasks } = await import("../src/storage.ts");
  saveTasks(tasks, f);
  const list = listTasks(false, f);
  assert.deepStrictEqual(list.map((t) => t.title), ["keep"]);
});
