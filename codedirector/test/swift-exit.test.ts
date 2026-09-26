/**
 * Indexing a Swift file must not hold the process open. V8 optimises the
 * Swift grammar's WebAssembly in the background and Node waits for it at
 * exit: 8s for a one-file `cdir index` on Node 22, against 0.2s of work
 * (core/parser.ts, chooseWasmTier). Measured on a real child process,
 * because the cost is paid after the program is done.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { makeGitRepo } from "./helpers";

const CLI = path.join(__dirname, "..", "src", "cli.js");

test("swift: a one-file index exits promptly", () => {
  const root = makeGitRepo({ "Sources/App/Model.swift": "public struct Model {\n  public func refresh() -> Int { 1 }\n}\n" });
  const started = Date.now();
  const r = spawnSync(process.execPath, [CLI, "index", "--root", root], { encoding: "utf8", timeout: 60_000 });
  const ms = Date.now() - started;
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 parsed/);
  // Generous: the stall this guards against is ~8s; the work is well under 1s.
  assert.ok(ms < 4000, `cdir index took ${ms}ms`);
});
