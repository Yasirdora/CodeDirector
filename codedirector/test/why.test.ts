/** Ranking determinism + blast-radius correctness on the fixture repo. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { coChange } from "../src/core/git";
import { buildGraph, directCallers, testFilesFor, transitiveCallers } from "../src/core/graph";
import { rankSymbols } from "../src/core/rank";
import { blastRadius, findSymbols, formatBlastRadius } from "../src/core/why";
import { copyFixture, makeGitRepo } from "./helpers";

test("ranking is deterministic and biased toward anchors", async () => {
  const root = copyFixture();
  const { index } = await buildIndex(root);
  const graph = buildGraph(index);

  const run1 = rankSymbols(graph, ["src/service.ts#computeTotal"]);
  const run2 = rankSymbols(graph, ["src/service.ts#computeTotal"]);
  assert.deepEqual(
    run1.map((r) => r.symbol.id),
    run2.map((r) => r.symbol.id),
    "identical ordering across runs",
  );
  assert.deepEqual(
    run1.map((r) => r.score),
    run2.map((r) => r.score),
    "identical scores across runs",
  );

  const top5 = run1.slice(0, 5).map((r) => r.symbol.id);
  assert.ok(top5.includes("src/service.ts#computeTotal"), "anchor ranks at/near the top");
  assert.ok(
    top5.includes("src/math.ts#double"),
    "direct callee of anchor ranks highly",
  );
});

test("blast radius: direct + transitive callers", async () => {
  const root = copyFixture();
  const { index } = await buildIndex(root);
  const graph = buildGraph(index);

  const doubleId = "src/math.ts#double";
  const direct = directCallers(graph, doubleId).map((s) => s.id);
  assert.deepEqual(direct, ["src/service.ts#computeTotal"], "double called by computeTotal");

  const trans = transitiveCallers(graph, doubleId, 3);
  assert.deepEqual(trans.byDepth.get(1), ["src/service.ts#computeTotal"]);
  assert.deepEqual(
    trans.byDepth.get(2),
    ["src/service.ts#Service.run", "test/service.test.ts#<toplevel>"],
    "computeTotal is called by Service.run and by the test file's top level",
  );
  assert.deepEqual(trans.byDepth.get(3), ["src/main.ts#<toplevel>"]);
  assert.equal(trans.total, 4);
});

test("blast radius: test files referencing a symbol", async () => {
  const root = copyFixture();
  const { index } = await buildIndex(root);
  const graph = buildGraph(index);

  const computeTotal = graph.symbols.get("src/service.ts#computeTotal")!;
  assert.deepEqual(testFilesFor(index, computeTotal), ["test/service.test.ts"]);

  const double = graph.symbols.get("src/math.ts#double")!;
  assert.deepEqual(
    testFilesFor(index, double),
    [],
    "double is not referenced by tests directly (reached only via computeTotal)",
  );
});

test("blastRadius report: findSymbols exact + substring, formatting", async () => {
  const root = copyFixture();
  const { index } = await buildIndex(root);
  const graph = buildGraph(index);

  assert.equal(findSymbols(graph, "computeTotal").length, 1, "exact name match");
  assert.ok(findSymbols(graph, "compute").length >= 2, "substring match finds computeTotal + computeArea");
  assert.equal(findSymbols(graph, "nonexistentSymbol").length, 0);

  const report = blastRadius(root, index, "computeTotal");
  assert.equal(report.matches.length, 1);
  const m = report.matches[0];
  assert.equal(m.symbol.file, "src/service.ts");
  assert.deepEqual(
    m.directCallers.map((s) => s.id),
    ["src/service.ts#Service.run", "test/service.test.ts#<toplevel>"].sort(),
  );
  assert.deepEqual(m.testFiles, ["test/service.test.ts"]);

  const text = formatBlastRadius(report);
  assert.ok(text.includes("computeTotal"));
  assert.ok(text.includes("src/service.ts"), "report mentions defining file");
});

test("co-change degrades gracefully outside a git repo", async () => {
  const root = copyFixture(); // tmp dir, not a git repo
  const cc = coChange(root, "src/math.ts");
  assert.equal(cc.available, false);
  assert.equal(cc.top.length, 0);
});

test("co-change coupling from a real git repo", async (t) => {
  const root = copyFixture();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"], { cwd: root });
    // second commit touching math.ts + service.ts together
    fs.appendFileSync(path.join(root, "src", "math.ts"), "\n// change\n");
    fs.appendFileSync(path.join(root, "src", "service.ts"), "\n// change\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "two"], { cwd: root });
  } catch {
    t.skip("git not available");
    return;
  }
  const cc = coChange(root, "src/math.ts", 5, 500, 2);
  assert.equal(cc.available, true);
  assert.equal(cc.commitsExamined, 2);
  assert.deepEqual(cc.top[0], { file: "src/service.ts", sharedCommits: 2 });
});

test("co-change: 1-commit history is skipped with a named reason (no noise)", () => {
  const root = makeGitRepo({ "src/a.ts": "export const a = 1;\n", ".editorconfig": "root = true\n" });
  const cc = coChange(root, "src/a.ts");
  assert.equal(cc.available, false, "tiny history must not report coupling");
  assert.ok(cc.reason?.includes("commit"), `reason names the cause: ${cc.reason}`);
  assert.equal(cc.top.length, 0);
});

test("co-change: shallow clone is skipped with a named reason", () => {
  const root = makeGitRepo({ "src/a.ts": "export const a = 1;\n" });
  // Simulate a shallow clone: git rev-parse reads .git/shallow when present.
  fs.writeFileSync(path.join(root, ".git", "shallow"), "");
  const cc = coChange(root, "src/a.ts");
  assert.equal(cc.available, false);
  assert.ok(cc.reason?.includes("shallow"), `reason names shallow clone: ${cc.reason}`);
});
