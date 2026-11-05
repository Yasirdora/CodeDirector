/**
 * The Change Report's coverage finding says only what can be true: nothing
 * for files with no symbols, and one honest line for a language whose tests
 * cdir cannot recognise (IL-0021 printed "no test file references its
 * symbols" for Markdown, YAML — and would for every Swift file).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { runWithLock } from "../src/run/run";
import { buildReport } from "../src/report/report";
import { makeGitRepo } from "./helpers";

async function reportFor(files: Record<string, string>, budget: string[], script: string): Promise<string[]> {
  const root = makeGitRepo(files);
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "tidy", { now: "2026-09-26T00:00:00.000Z", createdBy: "test" });
  lock.budget = { files: budget, symbols: [], maxFiles: budget.length, maxLines: 400 };
  lock.deny = [];
  lock.keep = [];
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  const outcome = await runWithLock(root, lock.id, [process.execPath, "-e", script], {
    stdio: "pipe",
    verifyOptions: { typecheck: false },
  });
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.record.violations));
  const report = await buildReport(root, lock.id, { typecheck: false, run: outcome.record, verification: outcome.record.verification });
  return report.findings.map((f) => f.text);
}

const TS = {
  "src/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
  "src/other.ts": "export function other() { return 1; }\n",
  "test/math.test.ts": 'import { add } from "../src/math";\nadd(1, 2);\n',
};

test("findings: a file with no symbols to reference gets no coverage finding", async () => {
  const findings = await reportFor({ ...TS, "docs/notes.md": "# notes\n", "config.yaml": "a: 1\n" }, ["docs/notes.md", "config.yaml"],
    'const f=require("fs");f.appendFileSync("docs/notes.md","more\\n");f.appendFileSync("config.yaml","b: 2\\n")');
  assert.deepEqual(findings, []);
});

test("findings: an uncovered source file in a language whose tests are recognised is still named", async () => {
  const findings = await reportFor(TS, ["src/math.ts", "src/other.ts"],
    'const f=require("fs");f.appendFileSync("src/math.ts","// x\\n");f.appendFileSync("src/other.ts","// x\\n")');
  assert.deepEqual(findings, [
    "src/other.ts changed in-budget, but no test file references its symbols — behavioral coverage unknown",
  ], "math.ts is covered by test/math.test.ts; other.ts is not");
});

const SWIFT = {
  "App/Model.swift": "public struct Model { public func refresh() -> Int { 1 } }\n",
  "App/Store.swift": "public struct Store { public func load() -> Int { 2 } }\n",
  "AppTests/ModelTests.swift":
    "import XCTest\n@testable import App\n\nfinal class ModelTests: XCTestCase {\n" +
    "    func testRefresh() {\n" +
    "        _ = Model().refresh()\n" +
    "    }\n" +
    "}\n",
};

test("findings: a Swift change covered by a test gets no 'no test file references' line", async () => {
  const findings = await reportFor(
    SWIFT,
    ["App/Model.swift"],
    'const f=require("fs");f.appendFileSync("App/Model.swift","// x\\n")',
  );
  assert.deepEqual(findings, []);
});

test("findings: an uncovered Swift file gets the per-file line, not the language-wide one", async () => {
  const findings = await reportFor(
    SWIFT,
    ["App/Store.swift"],
    'const f=require("fs");f.appendFileSync("App/Store.swift","// x\\n")',
  );
  assert.deepEqual(findings, [
    "App/Store.swift changed in-budget, but no test file references its symbols — behavioral coverage unknown",
  ]);
});

test("findings: a Swift project with no test target still gets one honest line, not one per file", async () => {
  const findings = await reportFor(
    {
      "Sources/App/Model.swift": "struct Model { func refresh() -> Int { 1 } }\n",
      "Sources/App/Store.swift": "struct Store { func load() -> Int { 2 } }\n",
    },
    ["Sources/App/Model.swift", "Sources/App/Store.swift"],
    'const f=require("fs");f.appendFileSync("Sources/App/Model.swift","// x\\n");f.appendFileSync("Sources/App/Store.swift","// x\\n")',
  );
  assert.deepEqual(findings, [
    "2 Swift file(s) changed in-budget (Sources/App/Model.swift, Sources/App/Store.swift); cdir recognises no Swift test files here, so their test coverage is unknown",
  ]);
});

test("findings: a package manifest is not behaviour, so it gets no 'no test file references' line", async () => {
  const findings = await reportFor(
    { ...SWIFT, "Pkg/Package.swift": "// swift-tools-version:5.9\nlet package = Package(name: \"Pkg\")\n" },
    ["App/Model.swift", "Pkg/Package.swift"],
    'const f=require("fs");f.appendFileSync("App/Model.swift","// x\\n");f.appendFileSync("Pkg/Package.swift","// x\\n")',
  );
  assert.deepEqual(findings, []);
});
