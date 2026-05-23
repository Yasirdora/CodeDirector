// t04 check: behavior snapshot — the CLI's observable output must be
// byte-identical to the pre-cleanup baseline. Runs with cwd = final repo.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert";

const store = path.join(mkdtempSync(path.join(tmpdir(), "t04-check-")), "tasks.json");
const env = { ...process.env, TASKS_FILE: store };
const cli = path.resolve("src/cli.ts");

const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" }).stdout;

const out = [
  run(["add", "alpha"]),
  run(["add", "beta"]),
  run(["list"]),
  run(["done", "1"]),
  run(["list"]),
  run(["list", "--all"]),
  run(["bogus-command"]),
].join("");

// NOTE: this snapshot pins the CURRENT behavior, including the planted
// done-index quirk (done 1 completes the oldest task, not the displayed
// first). t04 is a cleanup task: observable behavior must not change.
const EXPECTED = `added 1. alpha
added 2. beta
[ ] 2. beta
[ ] 1. alpha
done 1. alpha
[ ] 2. beta
[ ] 2. beta
[x] 1. alpha
usage: cli.ts add <title> | list [--all] [--json] | done <n>
`;

try {
  assert.strictEqual(out, EXPECTED);
  console.log("t04 check OK");
} catch (e) {
  console.error("FAIL: CLI observable behavior changed\n" + e.message);
  process.exit(1);
}
