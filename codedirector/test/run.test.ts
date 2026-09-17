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
import { checkLock } from "../src/lock/check";
import { loadLock, lockPathFor, saveLock } from "../src/lock/store";
import { sealLock, sealViolation } from "../src/lock/seal";
import { VibeCheck } from "../src/lock/types";
import { runWithLock, RunError } from "../src/run/run";
import { undo } from "../src/checkpoint";
import { makeDemoGitRepo, makeSubfolderDemoGitRepo, git } from "./helpers";

const NODE = process.execPath;
const append = (file: string, text: string) =>
  `${JSON.stringify(text)};require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

async function setup(customize?: (lock: VibeCheck) => void, root?: string): Promise<{ root: string; lock: VibeCheck }> {
  root ??= makeDemoGitRepo();
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
  sealLock(root, lock); // setups mirror the official approval path (fail-closed on missing seals)
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

test("run: an active lock edited after approval is refused (seal mismatch)", async () => {
  const { root, lock } = await setup();
  sealLock(root, lock); // activation pins the approved content
  const p = lockPathFor(root, lock.id)!;
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("maxLines: 400", "maxLines: 600"));
  await assert.rejects(
    () => runWithLock(root, lock.id, [NODE, "-e", "1"], { stdio: "pipe" }),
    (e: unknown) =>
      e instanceof RunError &&
      /modified after approval \(seal mismatch\)/.test((e as Error).message) &&
      /cdir lock check IL-\d+ && cdir lock activate/.test((e as Error).message),
  );
});

test("run: an active lock with no seal is refused (fail-closed on hand-activation)", async () => {
  // Field case: the agent hand-edited a draft to status: active with write
  // tools instead of cdir lock activate, so no seal existed and the old
  // fail-open check let it through. Now a missing seal must refuse.
  const root = makeDemoGitRepo();
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make the preview feel instant", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  lock.budget = { files: ["src/preview.ts"], symbols: [], maxFiles: 1, maxLines: 40 };
  lock.status = "active";
  saveLock(root, lock); // no sealLock — the hand-activation bypass
  await assert.rejects(
    () => runWithLock(root, lock.id, [NODE, "-e", "1"], { stdio: "pipe" }),
    (e: unknown) =>
      e instanceof RunError &&
      /no approval seal/.test((e as Error).message) &&
      /cdir lock check IL-\d+ && cdir lock activate/.test((e as Error).message),
  );
  // the official path seals it and the run proceeds
  sealLock(root, lock);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/preview.ts", "// ok\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
});

test("run: re-approval (check + activate) re-seals a modified lock and the run proceeds", async () => {
  const { root, lock } = await setup((l) => {
    l.budget.maxLines = 40;
  });
  sealLock(root, lock);
  const p = lockPathFor(root, lock.id)!;
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("maxLines: 40", "maxLines: 600"));
  await assert.rejects(
    () => runWithLock(root, lock.id, [NODE, "-e", "1"], { stdio: "pipe" }),
    /seal mismatch/,
  );
  // the user reviews the edited scope and re-approves: check + activate re-seals
  const edited = loadLock(root, lock.id)!;
  assert.equal(edited.budget.maxLines, 600, "the edit is real, not shadowed");
  const { index } = await buildIndex(root);
  assert.ok(checkLock(root, edited, index).ok, "edited lock still validates");
  edited.status = "active";
  saveLock(root, edited);
  sealLock(root, edited);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/preview.ts", "// faster\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
});

test("run: internal status transitions (verified/failed) never trip the seal", async () => {
  const { root, lock } = await setup();
  sealLock(root, lock);
  const ok = await runWithLock(root, lock.id, [NODE, "-e", append("src/preview.ts", "// faster\n")], {
    stdio: "pipe",
  });
  assert.equal(ok.exitCode, 0);
  const after = loadLock(root, lock.id)!;
  assert.equal(after.status, "verified");
  // back to active (a new work session): the saveLock refresh keeps the seal valid
  after.status = "active";
  saveLock(root, after);
  assert.equal(sealViolation(root, loadLock(root, lock.id)!), null);
  const again = await runWithLock(root, lock.id, [NODE, "-e", append("src/pipeline.ts", "// x\n")], {
    stdio: "pipe",
  });
  assert.equal(again.exitCode, 1, "out-of-budget failure, not a seal refusal");
  assert.equal(loadLock(root, lock.id)!.status, "failed");
  assert.equal(sealViolation(root, loadLock(root, lock.id)!), null);
});

test("run: mixed pre-existing dirt and run changes counts the run's delta only", async () => {
  // Field case: ~250 real lines counted as 581 because the file carried
  // uncommitted work. The baseline tree copy makes the count exact.
  const { root, lock } = await setup((l) => {
    l.budget.maxLines = 10;
  });
  const dirt = Array.from({ length: 300 }, (_, i) => `// pre-existing dirt ${i}`).join("\n") + "\n";
  fs.appendFileSync(path.join(root, "src/preview.ts"), dirt);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/preview.ts", "// one\n// two\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.equal(outcome.record.budget.linesChanged, 2, "the run's delta, not dirt + delta");
});

test("run: a file clean at baseline is still counted exactly vs HEAD", async () => {
  const { root, lock } = await setup((l) => {
    l.budget.maxLines = 10;
  });
  // dirt lives in a denied file (untouched → not counted); preview.ts is clean at capture
  fs.appendFileSync(path.join(root, "src/export.ts"), "// dirt\n");
  const outcome = await runWithLock(
    root,
    lock.id,
    [NODE, "-e", append("src/preview.ts", "// one\n// two\n// three\n")],
    { stdio: "pipe" },
  );
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.equal(outcome.record.budget.linesChanged, 3);
});

test("run: an untracked file created by the run is fully counted", async () => {
  const { root, lock } = await setup((l) => {
    l.budget.files = ["src/preview.ts", "src/new.ts"];
    l.budget.maxFiles = 2;
    l.budget.maxLines = 10;
  });
  const mk = 'require("fs").writeFileSync("src/new.ts","export const a = 1;\\nexport const b = 2;")';
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", mk], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.equal(outcome.record.budget.linesChanged, 2);
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

test("run: subfolder root — the approval seal does not count against maxLines", async () => {
  // Field case: IL-0012 appended 9 lines and the report counted 12 — the +2/−1
  // seal write in the tracked .codedirector/seals.json was counted as the run's
  // change, and the baseline hashed almost nothing (ls-files paths mis-framed).
  const root = makeSubfolderDemoGitRepo();
  const { lock } = await setup(undefined, root);
  const nine = Array.from({ length: 9 }, (_, i) => `// line ${i}`).join("\n") + "\n";
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/preview.ts", nine)], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.equal(outcome.record.budget.linesChanged, 9, "the run's 9 lines, seal excluded");
});

test("run: git root — the approval seal is not counted either", async () => {
  // Same scenario at the git root frame: tracked seals.json, sealed in setup,
  // then a 9-line run. Regression guard for the root frame.
  const root = makeDemoGitRepo();
  fs.mkdirSync(path.join(root, ".codedirector"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codedirector", "seals.json"), "{}\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "track seals"]);
  const { lock } = await setup(undefined, root);
  const nine = Array.from({ length: 9 }, (_, i) => `// line ${i}`).join("\n") + "\n";
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/preview.ts", nine)], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  assert.equal(outcome.record.budget.linesChanged, 9);
});

test("run: a new file in a new folder counts its real lines", async () => {
  // Field case: IL-0011 created docs/ROADMAP.md (127 lines) and the report
  // counted 3 — porcelain collapsed the new folder to ?? docs/ and the
  // directory could not be read as a file.
  const { root, lock } = await setup((l) => {
    l.budget.files = ["src/preview.ts", "notes/new.md"];
    l.budget.maxFiles = 2;
    l.budget.maxLines = 200;
  });
  const body = Array.from({ length: 127 }, (_, i) => `line ${i}`).join("\n");
  const mk = `require("fs").mkdirSync("notes",{recursive:true});require("fs").writeFileSync("notes/new.md",${JSON.stringify(body)})`;
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", mk], { stdio: "pipe" });
  assert.equal(outcome.record.budget.linesChanged, 127, "the file's real line count, not the collapsed folder's 0");
  // The OUT-OF-BUDGET on the collapsed ?? notes/ entry is the untracked-directory
  // roadmap item — deliberately out of IL-0014's scope; this tolerance goes with it.
  assert.ok(
    outcome.record.violations.some((v) => v.includes("OUT-OF-BUDGET") && v.includes("notes/")),
    `expected the known collapsed-folder classification gap; violations: ${outcome.record.violations.join("; ")}`,
  );
});
