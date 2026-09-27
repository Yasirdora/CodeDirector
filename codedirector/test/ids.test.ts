/**
 * Record identity tests: ids are unique in-process and across processes,
 * sortable in capture order, and state files are written all-or-nothing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { newRecordId, writeFileAtomic } from "../src/core/ids";
import { saveBaseline } from "../src/run/baseline";
import { makeGitRepo } from "./helpers";

const IDS_MODULE = path.join(__dirname, "..", "src", "core", "ids.js");

function childIds(count: number): Promise<string[]> {
  const script =
    `const { newRecordId } = require(${JSON.stringify(IDS_MODULE)});` +
    `for (let i = 0; i < ${count}; i++) console.log(newRecordId());`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      code === 0
        ? resolve(out.trim().split("\n").filter(Boolean))
        : reject(new Error(`child exited ${code}: ${err}`)),
    );
  });
}

test("ids: unique within one process, even inside one millisecond", () => {
  const at = new Date("2026-09-28T00:00:00.000Z");
  const ids = Array.from({ length: 10_000 }, () => newRecordId(at));
  assert.equal(new Set(ids).size, ids.length, "every id differs");
  assert.ok(ids.every((id) => /^\d{8}-\d{6}-\d{3}-[a-z0-9]+-[0-9a-f]{4}$/.test(id)), ids[0]);
});

test("ids: sortable in capture order across instants", () => {
  const a = newRecordId(new Date("2026-01-01T00:00:00.000Z"));
  const b = newRecordId(new Date("2026-01-01T00:00:00.001Z"));
  const c = newRecordId(new Date("2027-01-01T00:00:00.000Z"));
  assert.ok(a < b, `${a} < ${b}`);
  assert.ok(b < c, `${b} < ${c}`);
});

test("ids: four parallel processes never mint the same id", async () => {
  const lists = await Promise.all([0, 1, 2, 3].map(() => childIds(250)));
  const all = lists.flat();
  assert.equal(all.length, 1000);
  assert.equal(new Set(all).size, all.length, "ids collide across processes");
});

test("ids: writeFileAtomic round-trips and leaves no temp files behind", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-ids-"));
  const file = path.join(root, "record.json");
  writeFileAtomic(file, JSON.stringify({ n: 1 }));
  assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as { n: number }).n, 1);
  writeFileAtomic(file, JSON.stringify({ n: 2 }));
  assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as { n: number }).n, 2, "overwrite is complete");
  writeFileAtomic(file, "not json");
  assert.equal(fs.readFileSync(file, "utf8"), "not json");
  const leftovers = fs.readdirSync(root).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], `temp files left: ${leftovers.join(", ")}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("ids: two baselines captured in the same second keep two files", () => {
  const root = makeGitRepo({ "src/a.ts": "export const v = 1;\n" });
  const base = {
    lockId: "IL-0001",
    capturedAt: "2026-09-28T00:00:00.000Z",
    signatures: {},
    manifests: {},
    gitStatus: "",
    gitStatusHash: "x",
  };
  const first = saveBaseline(root, { ...base });
  const second = saveBaseline(root, { ...base });
  assert.notEqual(first, second, "same-second captures overwrite each other");
  assert.ok(fs.existsSync(first) && fs.existsSync(second), "both baselines survive");
  assert.equal((JSON.parse(fs.readFileSync(first, "utf8")) as { lockId: string }).lockId, "IL-0001");
});
