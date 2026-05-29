import assert from "node:assert";
import test from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checksPass, isTestHelper, matchPath, mechanicalProxy, runChecks, unintendedChanges } from "../src/measure";

test("matchPath: exact, star, double-star", () => {
  assert.ok(matchPath("src/a.ts", "src/a.ts"));
  assert.ok(!matchPath("src/a.ts", "src/b.ts"));
  assert.ok(matchPath("src/*.ts", "src/a.ts"));
  assert.ok(!matchPath("src/*.ts", "src/deep/a.ts"));
  assert.ok(matchPath("src/**", "src/deep/a.ts"));
  assert.ok(matchPath("**/*.ts", "src/deep/a.ts"));
});

test("isTestHelper: test paths are helpers", () => {
  assert.ok(isTestHelper("test/foo.test.ts"));
  assert.ok(isTestHelper("src/__tests__/x.ts"));
  assert.ok(isTestHelper("src/x.test.ts"));
  assert.ok(!isTestHelper("src/x.ts"));
});

test("unintendedChanges: files outside must_change minus test helpers", () => {
  const changed = ["src/slider.ts", "src/export.ts", "test/new.test.ts", "README.md"];
  const out = unintendedChanges(changed, ["src/slider.ts", "README.md"]);
  assert.deepStrictEqual(out, ["src/export.ts"]);
});

test("runChecks executes shell commands and records exit codes", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "checks-"));
  const results = await runChecks(dir, ["exit 0", "exit 3", "echo hi"]);
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].exitCode, 0);
  assert.strictEqual(results[1].exitCode, 3);
  assert.strictEqual(results[2].exitCode, 0);
  assert.ok(results[2].outputTail.includes("hi"));
  assert.strictEqual(checksPass(results), false);
  assert.strictEqual(checksPass([results[0], results[2]]), true);
  assert.strictEqual(checksPass([]), false);
});

test("mechanicalProxy: checks pass AND zero unintended", () => {
  assert.strictEqual(mechanicalProxy([{ command: "x", exitCode: 0, outputTail: "" }], []), true);
  assert.strictEqual(mechanicalProxy([{ command: "x", exitCode: 0, outputTail: "" }], ["src/x.ts"]), false);
  assert.strictEqual(mechanicalProxy([{ command: "x", exitCode: 1, outputTail: "" }], []), false);
});
