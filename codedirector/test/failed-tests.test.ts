/**
 * The failed-test reader: four output formats, each read from real output.
 * The XCTest, Swift Testing and vitest fixtures are short excerpts copied
 * verbatim from today's eDraft runs (paths and line numbers in each test);
 * TAP is the shape the tests-pass runner already reads.
 *
 * Every rule here has the input that looks like its case but is not: a
 * passing line, a failed SUITE, a file summary, a bare multiplication.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PROBE_EXCERPT_LINES } from "../src/run/probe";
import { tapFailedTestNames } from "../src/core/testNames";
import {
  MAX_FAILED_TESTS,
  MAX_NAMES_CHARS,
  failedTestLabels,
  formatFailedTests,
  readFailedTests,
} from "../src/verify/failedTests";
import { failingTestNames } from "../src/domains/node/tests";

const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures", "failed-tests");
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8");

/** The last non-empty lines — the tail a Change Report keeps today. */
function reportTail(output: string): string {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-PROBE_EXCERPT_LINES)
    .join("\n");
}

/** `node --test --test-reporter=tap` output from a real two-failure run (scratch copy). */
const TAP = [
  "TAP version 13",
  "# Subtest: adds two",
  "ok 1 - adds two",
  "# Subtest: keeps the cue with the speech",
  "not ok 2 - keeps the cue with the speech",
  "  ---",
  "  location: '/private/tmp/tap-probe/two.test.js:4:1'",
  "  ...",
  "# Subtest: moves a heading",
  "not ok 3 - moves a heading",
  "# tests 3",
  "# pass 1",
  "# fail 2",
].join("\n");

test("failed tests: XCTest under xcodebuild — the error line's file:line, one entry per test", () => {
  // rehearsal-base1-reproducing-failures.log, lines 338-370 (i3e build).
  const read = readFailedTests(fixture("xcodebuild.txt"));
  // The error line and the "Test Case … failed" line name the same test; the
  // error line carries the file, so the one entry keeps it.
  assert.deepEqual(read, {
    tests: [
      {
        name: "eDraftTests.I3cIdeasVisibleControlTests testRealAddReceiptNoteMarkerAndBarUndoCarryTheIdeaBothWays",
        location: "IdeasSheetAcceptanceTests.swift:914",
      },
    ],
    omitted: 0,
  });
});

test("failed tests: Swift Testing — names read past the tail the report keeps", () => {
  // red-swift-engine.log, lines 40-113 (German import).
  const output = fixture("swift-test.txt");
  const read = readFailedTests(output);
  assert.deepEqual(failedTestLabels(read), [
    "The speech runs on across the page break, as the English page's does (GermanImportTests.swift:102)",
    "The German page comes back as the screenplay it was, its furniture gone (GermanImportTests.swift:85)",
  ]);
  // The German page recorded three issues (locations 85, 88 and its failed
  // line): one test, not three.
  assert.equal(read.tests.filter((t) => t.name.startsWith("The German page")).length, 1);
  // What the report would have shown is the end of the log; neither name is in it.
  const tail = reportTail(output);
  for (const t of read.tests) assert.ok(!tail.includes(t.name), `the kept tail already holds "${t.name}"`);
});

test("failed tests: vitest — FAIL lines, rows folded in, a file summary is not a test", () => {
  // red-ts.log, lines 1-52 (a4 widow pagination).
  const read = readFailedTests(fixture("vitest.txt"));
  assert.equal(read.tests.length, 3);
  for (const t of read.tests)
    assert.ok(t.name.startsWith("src/paginate.test.ts > paginate · a scene heading never ends a page > moves "), t.name);
  // The durations and the file summary belong to no test.
  for (const t of read.tests) assert.ok(!/\d+ms|56 tests/.test(t.name), t.name);
  assert.ok(!read.tests.some((t) => t.name.includes("paginate.test.ts (")), "the ❯ summary line is not a test");

  // A row whose FAIL line is absent is still a test, without its duration,
  // when it sits under the file header vitest printed for it (vitest.txt's).
  const header = " ❯ src/paginate.test.ts (56 tests | 3 failed | 48 skipped) 349ms";
  const orphan = readFailedTests(`${header}\n     × a row nobody repeated 12ms\n`);
  assert.deepEqual(failedTestLabels(orphan), ["a row nobody repeated"]);
  // A name is a name in any script; only a bare count is not one.
  assert.deepEqual(failedTestLabels(readFailedTests(`${header}\n     × 二つの見出し 12ms\n`)), ["二つの見出し"]);
});

test("failed tests: TAP — the same names the tests-pass runner reads, and its five-name cap", () => {
  assert.deepEqual(tapFailedTestNames(TAP), ["keeps the cue with the speech", "moves a heading"]);
  assert.deepEqual(
    readFailedTests(TAP).tests.map((t) => t.name),
    ["keeps the cue with the speech", "moves a heading"],
  );
  const seven = Array.from({ length: 7 }, (_, i) => `not ok ${i + 1} - test ${i + 1}`).join("\n");
  assert.deepEqual(failingTestNames(seven), ["test 1", "test 2", "test 3", "test 4", "test 5"]);
});

test("failed tests: a passing run, a failed suite and a summary name nothing", () => {
  const passing = [
    "Test Case '-[AppTests.AppTests testAdds]' passed (0.001 seconds).",
    "✓ adds two 3ms",
    "ok 1 - adds two",
    "◇ Test \"adds two\" passed after 0.002 seconds.",
    "Test Suite 'AppTests' failed at 2026-10-17 03:23:39.271.",
    "** TEST EXECUTE FAILED **",
    "FAIL  src/broken.test.ts [ src/broken.test.ts ]",
    "error: Linker failed with 1 error",
    "× 2",
    "   Test Files  1 passed (1)",
    "        Tests  3 passed (3)",
  ].join("\n");
  const read = readFailedTests(passing);
  assert.deepEqual(read, { tests: [], omitted: 0 });
  assert.equal(formatFailedTests(read), "");
});

test("failed tests: the list is capped and the rest is one number", () => {
  const output = Array.from({ length: 13 }, (_, i) => `not ok ${i + 1} - test ${i + 1}`).join("\n");
  const read = readFailedTests(output);
  assert.equal(read.tests.length, MAX_FAILED_TESTS);
  assert.equal(read.omitted, 3);
  const expected = `${read.tests.map((t) => t.name).join(" · ")} (and 3 more)`;
  assert.equal(formatFailedTests(read), expected);
});

test("failed tests: a vitest '× ' row is a test only inside the file block vitest printed it under", () => {
  // The reviewer's non-test line (IL-0207 review): a '× ' summary is not a
  // test row. None of these follows a vitest file header.
  const notTests = ["× 2 files changed", "× 2", "Test Files  1 failed (1)", "      Tests  3 failed | 5 passed (56)"];
  assert.deepEqual(readFailedTests(notTests.join("\n")), { tests: [], omitted: 0 });

  // A real row sits under the file header vitest prints for it (the same
  // header as in vitest.txt); a blank line closes that block.
  const header = " ❯ src/paginate.test.ts (56 tests | 3 failed | 48 skipped) 349ms";
  const closed = readFailedTests([header, "     × moves a heading 12ms", "", "× 2 files changed"].join("\n"));
  assert.deepEqual(failedTestLabels(closed), ["moves a heading"]);

  // A code frame also starts with "❯" but carries no "(N tests…)": it opens
  // no file block, so a "× " line under it is still nobody's test.
  const frame = " ❯ src/paginate.test.ts:569:37\n× 2 files changed";
  assert.deepEqual(readFailedTests(frame), { tests: [], omitted: 0 });
});

test("failed tests: the report line's names are bounded; the reader keeps the whole name", () => {
  const long = "A".repeat(5000);
  const read = readFailedTests(`not ok 1 - ${long}`);
  const line = formatFailedTests(read);
  assert.ok(line.length <= MAX_NAMES_CHARS, `bounded: ${line.length} chars`);
  assert.ok(line.startsWith("AAA"), line.slice(0, 20));
  assert.ok(line.endsWith("…"), line.slice(-20));
  assert.equal(read.tests[0].name, long, "the reader is not cut; only the report line is");

  // A label that fits the budget exactly is kept whole — the bound must not
  // catch its own edge.
  const exact = "B".repeat(MAX_NAMES_CHARS);
  assert.equal(formatFailedTests(readFailedTests(`not ok 1 - ${exact}`)), exact);

  // Many long labels: whole labels while they fit, the rest counted — the
  // count covers both the length cut and the cap of MAX_FAILED_TESTS.
  const many = Array.from({ length: 12 }, (_, i) => `not ok ${i + 1} - ${String(i + 1).padStart(2, "0")}-${"C".repeat(97)}`).join("\n");
  const manyLine = formatFailedTests(readFailedTests(many));
  assert.ok(manyLine.length <= MAX_NAMES_CHARS, `bounded: ${manyLine.length} chars`);
  assert.match(manyLine, /\(and 8 more\)$/);
});
