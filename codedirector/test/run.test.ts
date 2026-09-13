/**
 * `cdir run` end-to-end tests in temp git repos: in-budget pass,
 * out-of-budget / deny / budget-exceeded violations, KEEP-surface diffs,
 * and draft refusal. Commands run as `node -e ...` for portability.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { saveLock } from "../src/lock/store";
import { VibeCheck } from "../src/lock/types";
import { runWithLock, RunError } from "../src/run/run";
import { undo } from "../src/checkpoint";
import { makeDemoGitRepo } from "./helpers";

const NODE = process.execPath;
const append = (file: string, text: string) =>
  `${JSON.stringify(text)};require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

async function setup(customize?: (lock: VibeCheck) => void): Promise<{ root: string; lock: VibeCheck }> {
  const root = makeDemoGitRepo();
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make the preview feel instant", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  lock.budget = { files: ["src/preview.ts", "src/slider.ts"], symbols: [], maxFiles: 2, maxLines: 400 };
  lock.deny = ["src/export.ts"];
  lock.change = "preview responsiveness during drag only";
  lock.goal = "input-to-paint under 50ms during drag";
  customize?.(lock);
  lock.status = "active";
  saveLock(root, lock);
  return { root, lock };
}

test("run: in-budget edit exits 0 and writes a run record", async () => {
  const { root, lock } = await setup();
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/preview.ts", "// faster\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.record.exitCode, 0);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.record.violations, []);
  assert.equal(outcome.record.changed.length, 1);
  assert.equal(outcome.record.changed[0].path, "src/preview.ts");
  assert.equal(outcome.record.changed[0].class, "in-budget");
  assert.ok(fs.existsSync(outcome.recordPath), "run record written");
  assert.ok(outcome.record.checkpoint.tag.startsWith("cdir/ckpt-"), "checkpoint taken");
  assert.ok(fs.existsSync(path.join(root, outcome.record.baselinePath)), "baseline written");
});

test("run: pre-existing dirty tree does not count against maxLines", async () => {
  // Field case: a repo with ~1.5k lines of unrelated uncommitted work;
  // the run edits one in-budget file by a line. The 40-line cap must see
  // the run's delta only — pre-existing dirt is neither a classification
  // hit nor line budget. Dirt sits in a DENIED file on purpose: untouched
  // bytes must not trip the deny rule either.
  const { root, lock } = await setup((l) => {
    l.budget.maxLines = 40;
  });
  const dirt = Array.from({ length: 60 }, (_, i) => `// unrelated dirt ${i}`).join("\n") + "\n";
  fs.appendFileSync(path.join(root, "src/export.ts"), dirt);
  fs.appendFileSync(path.join(root, "src/slider.ts"), dirt);

  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/preview.ts", "// faster\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.record.exitCode, 0);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.record.violations, []);
  assert.equal(outcome.record.changed.length, 1, "only the run-touched file is classified");
  assert.equal(outcome.record.changed[0].path, "src/preview.ts");
  assert.ok(
    outcome.record.budget.linesChanged <= 5,
    `only the run's own lines count against maxLines, got ${outcome.record.budget.linesChanged}`,
  );
});

test("run: out-of-budget edit exits non-zero and names the offending path", async () => {
  const { root, lock } = await setup();
  const outcome = await runWithLock(
    root,
    lock.id,
    [NODE, "-e", append("src/pipeline.ts", "// out of scope\n")],
    { stdio: "pipe" },
  );
  assert.equal(outcome.exitCode, 1);
  assert.ok(
    outcome.record.violations.some((v) => v.includes("OUT-OF-BUDGET") && v.includes("src/pipeline.ts")),
    `violations: ${outcome.record.violations.join("; ")}`,
  );
  const change = outcome.record.changed.find((c) => c.path === "src/pipeline.ts");
  assert.equal(change?.class, "out-of-budget");

  // nothing auto-reverted; the human decides — cdir undo restores it
  assert.ok(fs.readFileSync(path.join(root, "src", "pipeline.ts"), "utf8").includes("out of scope"));
  undo(root, { force: true });
  assert.ok(!fs.readFileSync(path.join(root, "src", "pipeline.ts"), "utf8").includes("out of scope"));
});

test("run: deny-listed edit is a violation, reported as DENY", async () => {
  const { root, lock } = await setup();
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/export.ts", "// nope\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 1);
  assert.ok(
    outcome.record.violations.some((v) => v.includes("DENY") && v.includes("src/export.ts")),
    `violations: ${outcome.record.violations.join("; ")}`,
  );
  const change = outcome.record.changed.find((c) => c.path === "src/export.ts");
  assert.equal(change?.class, "denied");
  assert.equal(change?.matchedDeny, "src/export.ts");
});

test("run: exceeding maxFiles is a budget violation", async () => {
  const { root, lock } = await setup((l) => {
    l.budget.maxFiles = 1;
  });
  const outcome = await runWithLock(
    root,
    lock.id,
    [NODE, "-e", append("src/preview.ts", "// a\n") + ";" + append("src/slider.ts", "// b\n")],
    { stdio: "pipe" },
  );
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.record.changed.length, 2);
  assert.ok(
    outcome.record.violations.some((v) => v.includes("BUDGET") && v.includes("maxFiles")),
    `violations: ${outcome.record.violations.join("; ")}`,
  );
  assert.equal(outcome.record.budget.filesChanged, 2);
  assert.equal(outcome.record.budget.maxFiles, 1);
});

test("run: api-unchanged KEEP clause catches a signature change", async () => {
  const { root, lock } = await setup((l) => {
    l.budget.files = ["src/pipeline.ts"];
    l.budget.maxFiles = 1;
    l.keep = [{ kind: "api-unchanged", symbols: ["src/pipeline.ts#ImagePipeline.renderExport"] }];
  });
  const changeSig =
    'const fs=require("fs");const p="src/pipeline.ts";' +
    'fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace("renderExport(intensity: number): Uint8Array","renderExport(intensity: number, extra?: boolean): Uint8Array"))';
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", changeSig], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 1);
  assert.ok(
    outcome.record.violations.some((v) => v.includes("KEEP api-unchanged")),
    `violations: ${outcome.record.violations.join("; ")}`,
  );
  const kr = outcome.record.keepResults.find((k) => k.kind === "api-unchanged");
  assert.equal(kr?.status, "violated");
});

test("run: --allow-expand logs the override; KEEP violations still fail", async () => {
  const { root, lock } = await setup();
  const outcome = await runWithLock(
    root,
    lock.id,
    [NODE, "-e", append("src/pipeline.ts", "// expanded scope\n")],
    { stdio: "pipe", allowExpand: true },
  );
  assert.equal(outcome.exitCode, 0, "scope expansion accepted via explicit override");
  assert.equal(outcome.record.allowExpand, true);
});

test("run: command failure exits non-zero even without violations", async () => {
  const { root, lock } = await setup();
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", "process.exit(3)"], { stdio: "pipe" });
  assert.equal(outcome.record.exitCode, 3);
  assert.equal(outcome.exitCode, 1);
});

test("run: a draft lock refuses to run", async () => {
  const root = makeDemoGitRepo();
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make the preview feel instant", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  await assert.rejects(
    () => runWithLock(root, lock.id, [NODE, "-e", "1"], { stdio: "pipe" }),
    (e: unknown) => e instanceof RunError && /draft/.test((e as Error).message),
  );
});

test("run: no-new-dependency KEEP clause diffs manifests against the baseline", async () => {
  const { root, lock } = await setup((l) => {
    l.keep = [{ kind: "no-new-dependency" }];
  });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"demo","dependencies":{}}\n');
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "add pkg"], {
    cwd: root,
  });

  const clean = await runWithLock(root, lock.id, [NODE, "-e", append("src/preview.ts", "// ok\n")], {
    stdio: "pipe",
  });
  assert.equal(clean.exitCode, 0);
  assert.ok(clean.record.keepResults.some((k) => k.kind === "no-new-dependency" && k.status === "ok"));

  const dirty = await runWithLock(
    root,
    lock.id,
    [
      NODE,
      "-e",
      'require("fs").writeFileSync("package.json",JSON.stringify({name:"demo",dependencies:{lodash:"*"}}))',
    ],
    { stdio: "pipe" },
  );
  assert.equal(dirty.exitCode, 1);
  assert.ok(
    dirty.record.violations.some((v) => v.includes("KEEP no-new-dependency")),
    `violations: ${dirty.record.violations.join("; ")}`,
  );
});
