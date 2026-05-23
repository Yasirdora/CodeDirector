// t05 check: `done 1` must complete the task shown FIRST by `list`
// (newest first), not the oldest entry in the storage file.
// Runs with cwd = final repo root; exits non-zero unless the bug is fixed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { addTask, listTasks, completeTask } = await import(path.resolve("src/tasks.ts"));

const f = path.join(mkdtempSync(path.join(tmpdir(), "t05-check-")), "tasks.json");
addTask("oldest", f);
addTask("newest", f);

const shown = listTasks(false, f);
if (shown[0].title !== "newest") {
  console.error("FAIL: list does not show newest first");
  process.exit(1);
}
const completed = completeTask(1, f); // user means the first DISPLAYED task
if (completed.title !== "newest") {
  console.error(`FAIL: done 1 completed "${completed.title}", expected "newest"`);
  process.exit(1);
}
console.log("t05 check OK");
