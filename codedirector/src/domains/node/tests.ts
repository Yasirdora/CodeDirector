/**
 * JavaScript/TypeScript test conventions, and the `node --test` runner the
 * tests-pass KEEP clause executes through.
 */

import type { TestRunnerDescription } from "../../domain/types";
import { tapFailedTestNames } from "../../core/testNames";

const TEST_FILE_RE = /(__tests__\/|\.(test|spec)\.[cm]?[tj]sx?$)/;

export function isNodeTestFile(relPath: string): boolean {
  return TEST_FILE_RE.test(relPath);
}

/**
 * Compress a long test-file list into directory globs: files under
 * `__tests__/` collapse to `<dir>/__tests__/**`; directories with ≥2 test
 * files collapse to `<dir>/**\/*.test.*` / `*.spec.*`. Falls back to
 * individual paths. Deterministic (sorted output).
 */
export function compressTestPaths(testFiles: string[]): string[] {
  const globs = new Set<string>();
  const singles: string[] = [];
  const byDir = new Map<string, string[]>();
  for (const f of [...testFiles].sort()) {
    const segs = f.split("/");
    const tt = segs.indexOf("__tests__");
    if (tt !== -1) {
      globs.add(segs.slice(0, tt + 1).join("/") + "/**");
      continue;
    }
    const dir = segs.slice(0, -1).join("/");
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  for (const [dir, files] of [...byDir.entries()].sort()) {
    if (files.length < 2) {
      singles.push(...files);
      continue;
    }
    const hasTest = files.some((f) => f.includes(".test."));
    const hasSpec = files.some((f) => f.includes(".spec."));
    if (hasTest) globs.add(`${dir}/**/*.test.*`);
    if (hasSpec) globs.add(`${dir}/**/*.spec.*`);
    for (const f of files) {
      if (!f.includes(".test.") && !f.includes(".spec.")) singles.push(f);
    }
  }
  return [...[...globs].sort(), ...singles.sort()];
}

/**
 * Test files `node --test` can run: JavaScript, and TypeScript through type
 * stripping. A tests-pass glob that reaches anything else (a Swift, Python or
 * JSX file) cannot be measured by this runner — node reads it as a script,
 * fails, and the clause used to report a passing suite as failing (a Swift
 * test file, reproduced on 0.4.5). Such suites belong in verifyCommand.
 */
export const NODE_TEST_FILE = /\.(?:[cm]?js|[cm]?ts)$/;

/**
 * Failing test names from TAP output (the first five — what the tests-pass
 * detail shows). The parser is the core's, so a node test is named the same
 * way here and in a failing verifyCommand's record.
 */
export function failingTestNames(output: string): string[] {
  return tapFailedTestNames(output, 5);
}

export const nodeTestRunner: TestRunnerDescription = {
  id: "node.test",
  label: "node --test",
  covers: "JavaScript/TypeScript",
  acceptsFile: (relPath) => NODE_TEST_FILE.test(relPath),
  argv(files) {
    const argv = [process.execPath];
    const major = parseInt(process.versions.node, 10);
    if (major >= 22 && files.some((f) => /\.[cm]?tsx?$/.test(f))) {
      argv.push("--experimental-strip-types");
    }
    argv.push("--test", "--test-reporter=tap", ...files);
    return argv;
  },
  failures: failingTestNames,
};
