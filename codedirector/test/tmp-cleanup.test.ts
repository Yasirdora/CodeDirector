import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("a test process's temp folders, its children's included, are gone when it ends", () => {
  const helpers = path.join(__dirname, "helpers.js");
  // A test process: it loads the helpers, makes a folder, and starts a child
  // that makes one too (as a cdir it starts would), then ends.
  const script = [
    `require(${JSON.stringify(helpers)});`,
    `const fs = require("node:fs"), os = require("node:os"), path = require("node:path");`,
    `const mine = fs.mkdtempSync(path.join(os.tmpdir(), "mine-"));`,
    `const child = require("node:child_process").execFileSync(process.execPath, ["-e",`,
    `  "process.stdout.write(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'child-')))"],`,
    `  { encoding: "utf8" });`,
    `process.stdout.write(JSON.stringify({ root: process.env.TMPDIR, mine, child }));`,
  ].join("\n");
  const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
  assert.ok(out.mine.startsWith(out.root) && out.child.startsWith(out.root), "both under the process's folder");
  for (const dir of [out.root, out.mine, out.child]) assert.equal(fs.existsSync(dir), false, `${dir} is gone`);
});
