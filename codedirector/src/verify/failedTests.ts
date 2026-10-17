/**
 * Name the tests a failing command reported, from its WHOLE output.
 *
 * The Change Report keeps only a command's last few lines. A failing test
 * run says which tests failed — often hundreds of lines before that tail: a
 * runner's error block, then build noise, then "Testing started". This
 * module reads the full captured output and returns the failed tests, once
 * each, in the order the runner first named them.
 *
 * Four line shapes are recognised, each one a line a runner prints only for
 * a FAILED test:
 *
 *   XCTest        Test Case '-[Module.Class test]' failed
 *                 <file>:<line>: error: -[Module.Class test] : ...
 *   Swift Testing Test "name" recorded an issue at File.swift:12
 *                 Test "name" failed after ...
 *   vitest        FAIL  file > describe > name
 *                 × name
 *   TAP           not ok 3 - name
 *
 * The error line carries the file and line; the other forms do not, so a
 * test named by both keeps the location the output gave it.
 */

export interface FailedTest {
  /** The test as the runner names it. */
  name: string;
  /** `File.swift:12` when the output's line carried a file and line. */
  location?: string;
}

export interface FailedTestsRead {
  /** Distinct failing tests, in output order, capped at `max`. */
  tests: FailedTest[];
  /** Distinct failing tests past the cap — the count the detail adds. */
  omitted: number;
}

/** How many failed tests a record names; the rest is one number. */
export const MAX_FAILED_TESTS = 10;

/** The failing test a TAP line names (`not ok 3 - name`), or null. */
export function tapFailureName(line: string): string | null {
  const m = /^\s*not ok \d+ - (.+)$/.exec(line);
  return m ? m[1].trim() : null;
}

/**
 * Failing test names from TAP output, deduplicated, at most `limit`. The
 * tests-pass runner reads its output through this, so a node test is named
 * the same way wherever it is reported.
 */
export function tapFailedTestNames(output: string, limit = Number.POSITIVE_INFINITY): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const name = tapFailureName(line);
    if (name === null || names.includes(name)) continue;
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

const XCTEST_CASE = /^\s*Test Case ['"]-\[([^\]]+)\]['"] failed/;
const XCTEST_ERROR = /^\s*(?:(\S+):(\d+):\s*)?error: -\[([^\]]+)\]\s*:/;
const SWIFT_ISSUE = /^\s*[^\w\s]*\s*Test "(.+?)" recorded an issue at ([^\s:]+):(\d+)/;
const SWIFT_FAILED = /^\s*[^\w\s]*\s*Test "(.+?)" failed after/;
const VITEST_FAIL = /^\s*FAIL\s+(\S.*? > .+?)\s*$/;
const VITEST_ROW = /^\s*×\s+(.+?)\s*$/;
/** vitest appends the duration to a test row: "… cannot split 180ms". */
const VITEST_DURATION = /\s+\d+(?:\.\d+)?(?:ms|s)$/;

function fileName(p: string): string {
  return p.split("/").pop() ?? p;
}

interface Candidate {
  /** Which format named it; two formats never name the same test. */
  kind: "xctest" | "swift" | "vitest" | "vitest-row" | "tap";
  name: string;
  location?: string;
  /** Line number in the output — keeps the report in the runner's order. */
  index: number;
}

/** Every line that names a failed test, as printed, nothing deduplicated yet. */
function candidates(output: string): Candidate[] {
  const found: Candidate[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let m = XCTEST_CASE.exec(line);
    if (m) {
      found.push({ kind: "xctest", name: m[1], index });
      continue;
    }
    m = XCTEST_ERROR.exec(line);
    if (m) {
      const location = m[1] !== undefined ? `${fileName(m[1])}:${m[2]}` : undefined;
      found.push({ kind: "xctest", name: m[3], ...(location !== undefined ? { location } : {}), index });
      continue;
    }
    m = SWIFT_ISSUE.exec(line);
    if (m) {
      found.push({ kind: "swift", name: m[1], location: `${fileName(m[2])}:${m[3]}`, index });
      continue;
    }
    m = SWIFT_FAILED.exec(line);
    if (m) {
      found.push({ kind: "swift", name: m[1], index });
      continue;
    }
    m = VITEST_FAIL.exec(line);
    if (m) {
      found.push({ kind: "vitest", name: m[1].trim(), index });
      continue;
    }
    m = VITEST_ROW.exec(line);
    if (m) {
      const name = m[1].replace(VITEST_DURATION, "").trim();
      // A row is a test only when it reads like a name, not a bare number
      // (any script's letters count — the names here are often German).
      if (/\p{L}/u.test(name)) found.push({ kind: "vitest-row", name, index });
      continue;
    }
    const tap = tapFailureName(line);
    if (tap !== null) found.push({ kind: "tap", name: tap, index });
  }
  return found;
}

/**
 * The failed tests a command's whole output names. A test that fails
 * several assertions (one XCTest error per assertion, several Swift Testing
 * issues) is one entry; a vitest row repeats the test its FAIL line already
 * names in full, so the row is dropped.
 */
export function readFailedTests(output: string, max = MAX_FAILED_TESTS): FailedTestsRead {
  const all = candidates(output);
  const distinct: Candidate[] = [];
  const byKey = new Map<string, Candidate>();
  const vitestRows: Candidate[] = [];
  for (const c of all) {
    if (c.kind === "vitest-row") {
      vitestRows.push(c);
      continue;
    }
    const key = `${c.kind}:${c.name}`;
    const seen = byKey.get(key);
    if (seen) {
      if (seen.location === undefined && c.location !== undefined) seen.location = c.location;
      continue;
    }
    byKey.set(key, c);
    distinct.push(c);
  }
  const fullNames = new Set(
    all.filter((c) => c.kind === "vitest").map((c) => c.name.split(" > ").pop()!.trim()),
  );
  for (const row of vitestRows) if (!fullNames.has(row.name)) distinct.push(row);
  distinct.sort((a, b) => a.index - b.index);
  const tests = distinct.slice(0, max).map((c) => (c.location !== undefined ? { name: c.name, location: c.location } : { name: c.name }));
  return { tests, omitted: Math.max(0, distinct.length - max) };
}

/** One label per test: its name, and the file:line when the output gave one. */
export function failedTestLabels(read: FailedTestsRead): string[] {
  return read.tests.map((t) => (t.location !== undefined ? `${t.name} (${t.location})` : t.name));
}

/** The names as one line for the report; past the cap it ends "(and N more)". */
export function formatFailedTests(read: FailedTestsRead): string {
  const labels = failedTestLabels(read);
  return read.omitted > 0 ? `${labels.join(" · ")} (and ${read.omitted} more)` : labels.join(" · ");
}
