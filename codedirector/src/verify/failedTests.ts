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
 *                 × name          (only under its "❯ file (N tests…)" header)
 *   TAP           not ok 3 - name
 *
 * The error line carries the file and line; the other forms do not, so a
 * test named by both keeps the location the output gave it. The TAP reader
 * lives in src/core/testNames.ts: the node domain reads it too.
 */

import { tapFailureName } from "../core/testNames";

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

/** How many characters of test names one report line carries; the rest is one count. */
export const MAX_NAMES_CHARS = 400;

/** Below this a cut name says nothing recognisable; that label is counted instead. */
const MIN_CUT_CHARS = 24;

/** The separator between names on the report line. */
const NAMES_SEP = " · ";

const XCTEST_CASE = /^\s*Test Case ['"]-\[([^\]]+)\]['"] failed/;
const XCTEST_ERROR = /^\s*(?:(\S+):(\d+):\s*)?error: -\[([^\]]+)\]\s*:/;
const SWIFT_ISSUE = /^\s*[^\w\s]*\s*Test "(.+?)" recorded an issue at ([^\s:]+):(\d+)/;
const SWIFT_FAILED = /^\s*[^\w\s]*\s*Test "(.+?)" failed after/;
const VITEST_FAIL = /^\s*FAIL\s+(\S.*? > .+?)\s*$/;
/** The header vitest prints above a file's rows: "❯ src/a.test.ts (2 tests | 1 failed) 12ms". */
const VITEST_FILE = /^\s*❯\s+\S+\s+\(/;
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
  // A vitest row names a test only inside the block its file header opens;
  // a blank line ends that block. A "× " line anywhere else (a summary such
  // as "× 2 files changed") belongs to no file and to no test.
  let inVitestFile = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim().length === 0) {
      inVitestFile = false;
      continue;
    }
    if (VITEST_FILE.test(line)) {
      inVitestFile = true;
      continue;
    }
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
      // Inside a file block, a row is a test unless the text is only a bare
      // count (any script's letters count — the names here are often German).
      if (inVitestFile && /\p{L}/u.test(name)) found.push({ kind: "vitest-row", name, index });
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

/**
 * The names as one line for the report. Labels are kept whole while they fit
 * `maxChars`; the first that does not is cut with "…", and every label after
 * it — with those past MAX_FAILED_TESTS — is one count. A label that fits
 * exactly is kept whole. Names and count together stay within `maxChars`
 * whenever a label can be named at all, which the default budget always can.
 */
export function formatFailedTests(read: FailedTestsRead, maxChars = MAX_NAMES_CHARS): string {
  const labels = failedTestLabels(read);
  const total = labels.length + read.omitted;
  const kept: string[] = [];
  let used = 0;
  const line = (): string => {
    const rest = total - kept.length;
    return `${kept.join(NAMES_SEP)}${rest > 0 ? `${kept.length > 0 ? " " : ""}(and ${rest} more)` : ""}`;
  };
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index];
    const sep = kept.length > 0 ? NAMES_SEP.length : 0;
    const rest = total - kept.length - 1;
    const more = rest > 0 ? ` (and ${rest} more)`.length : 0;
    if (used + sep + label.length + more <= maxChars) {
      kept.push(label);
      used += sep + label.length;
      continue;
    }
    const room = maxChars - used - sep - more - 1; // one char for the "…"
    if (room >= MIN_CUT_CHARS) kept.push(`${label.slice(0, room).trimEnd()}…`);
    return line();
  }
  return line();
}
