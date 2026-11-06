/**
 * The tests an Xcode result bundle (.xcresult) recorded as failed.
 *
 * `xcodebuild test -quiet` prints no failed test on its console — the run
 * ends on "Testing started" and an exit code (measured, Xcode 27). The
 * bundle it writes has them: `xcresulttool get test-results summary` prints
 * a JSON summary whose `testFailures` name each failed test and its message.
 */

import type { ResultReader } from "../../domain/types";

interface Summary {
  testFailures?: Array<{ testIdentifierString?: unknown; testName?: unknown; failureText?: unknown }>;
}

/** The first line of a message, bounded: enough to know what to open. */
function firstLine(text: string, max = 200): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export const XCRESULT_READER: ResultReader = {
  suffix: ".xcresult",
  argv: (resultPath) => ["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", resultPath],
  failures(output) {
    let summary: Summary;
    try {
      summary = JSON.parse(output) as Summary;
    } catch {
      return { tests: [] };
    }
    const tests: string[] = [];
    let message: string | undefined;
    for (const failure of summary.testFailures ?? []) {
      const name =
        typeof failure.testIdentifierString === "string" && failure.testIdentifierString !== ""
          ? failure.testIdentifierString
          : typeof failure.testName === "string"
            ? failure.testName
            : "";
      if (name === "" || tests.includes(name)) continue;
      tests.push(name);
      if (message === undefined && typeof failure.failureText === "string" && failure.failureText.trim() !== "") {
        message = firstLine(failure.failureText);
      }
    }
    return message === undefined ? { tests } : { tests, message };
  },
};
