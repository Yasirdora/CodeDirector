// t07 check: CLI validates input and fails gracefully (non-zero exit,
// human-readable error) on bad input; happy path still works.
// Runs with cwd = final repo root.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const store = path.join(mkdtempSync(path.join(tmpdir(), "t07-check-")), "tasks.json");
const env = { ...process.env, TASKS_FILE: store };
const cli = path.resolve("src/cli.ts");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
}

const empty = run(["add", ""]);
if (empty.status === 0) {
  console.error("FAIL: `add \"\"` succeeded; expected validation error");
  process.exit(1);
}
const badDone = run(["done", "abc"]);
if (badDone.status === 0) {
  console.error("FAIL: `done abc` succeeded; expected validation error");
  process.exit(1);
}
const ok = run(["add", "real task"]);
if (ok.status !== 0 || !ok.stdout.includes("real task")) {
  console.error("FAIL: happy path `add` broke");
  process.exit(1);
}
console.log("t07 check OK");
