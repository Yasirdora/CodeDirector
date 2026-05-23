// t03 check: `done` output must use the same task format as `list`
// ("[x] <id>. <title>"), not its old ad-hoc format.
// Runs with cwd = final repo root.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const store = path.join(mkdtempSync(path.join(tmpdir(), "t03-check-")), "tasks.json");
const env = { ...process.env, TASKS_FILE: store };
const cli = path.resolve("src/cli.ts");

spawnSync(process.execPath, [cli, "add", "only task"], { env, encoding: "utf8" });
const done = spawnSync(process.execPath, [cli, "done", "1"], { env, encoding: "utf8" });
if (done.status !== 0) {
  console.error("FAIL: done command errored");
  process.exit(1);
}
if (!/\[x\]\s+1\.\s+only task/.test(done.stdout)) {
  console.error(`FAIL: done output not in list format, got: ${done.stdout.trim()}`);
  process.exit(1);
}
console.log("t03 check OK");
