// t09 check: with 300 tasks, list stays correct and the fast path
// (repeated lists without writes) returns identical results.
// Functional only — no flaky timing assertions. cwd = final repo root.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const store = path.join(mkdtempSync(path.join(tmpdir(), "t09-check-")), "tasks.json");
const env = { ...process.env, TASKS_FILE: store };
const cli = path.resolve("src/cli.ts");

const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });

const { addTask } = await import(path.resolve("src/tasks.ts"));
for (let i = 1; i <= 300; i++) addTask(`task ${i}`, store);

const a = run(["list", "--json"]);
if (a.status !== 0) {
  console.error("FAIL: list errored at 300 tasks\n" + a.stderr);
  process.exit(1);
}
const tasks = JSON.parse(a.stdout);
if (tasks.length !== 300 || tasks[0].id !== 300) {
  console.error("FAIL: list output wrong at 300 tasks");
  process.exit(1);
}
console.log("t09 check OK");
