/** Shared test helpers (not a test file — imported by *.test.ts). */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FIXTURE_REPO = path.join(__dirname, "..", "..", "test", "fixtures", "basic-repo");

/** Copy the fixture repo into a fresh temp dir and return its path. */
export function copyFixture(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-test-"));
  fs.cpSync(FIXTURE_REPO, tmp, { recursive: true });
  return tmp;
}
