/**
 * Test names read from a runner's output — one reader, one place.
 *
 * A TAP line (`not ok 3 - name`) is the shape `node --test` prints: the
 * tests-pass clause reads it (src/domains/node), and a failing verifyCommand's
 * output carries the same shape. It lives in the core because both layers
 * consult it and neither may depend on the other: a domain depends on the
 * core, the core never depends on a domain (test/domains.test.ts), and the
 * verify layer sits beside the domain, not under it.
 */

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
