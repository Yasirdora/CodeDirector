/**
 * W2: a workspace package whose git-ignored build output is older than the
 * sources the run changed is named — an error about the package may come
 * from that stale build, not from the change.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { VibeCheck } from "../src/lock/types";
import { runWithLock, RunOutcome } from "../src/run/run";
import { buildReport, Finding } from "../src/report/report";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;
const append = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

interface RepoOptions {
  /** The root package.json's `workspaces` value; absent when undefined. */
  workspaces?: unknown;
  /** False leaves dist untracked rather than ignored. */
  ignoreDist?: boolean;
}

/** A root with one workspace package whose exports point into `dist/`. */
function repoWithPackage(opts: RepoOptions = {}): string {
  const rootPkg: Record<string, unknown> = { name: "root" };
  if (opts.workspaces !== undefined) rootPkg.workspaces = opts.workspaces;
  const files: Record<string, string> = {
    "package.json": JSON.stringify(rootPkg) + "\n",
    "pkgs/a/package.json":
      JSON.stringify({
        name: "pkg-a",
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      }) + "\n",
    "pkgs/a/src/x.ts": "export const x = 1;\n",
  };
  if (opts.ignoreDist !== false) files[".gitignore"] = "pkgs/a/dist/\n";
  const root = makeGitRepo(files);
  const dist = path.join(root, "pkgs", "a", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.d.ts"), "export declare const x: number;\n");
  fs.writeFileSync(path.join(dist, "index.js"), "exports.x = 1;\n");
  return root;
}

async function activeLock(root: string): Promise<VibeCheck> {
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "change the package", {
    now: "2026-11-04T00:00:00.000Z",
    createdBy: "test",
  });
  lock.budget = { files: ["pkgs/a/src/x.ts"], symbols: [], maxFiles: 1, maxLines: 400 };
  lock.deny = [];
  lock.keep = [];
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return lock;
}

/** Run a change in the package; the run must pass so only the finding is judged. */
async function changePackage(root: string, command?: string): Promise<{ lock: VibeCheck; outcome: RunOutcome }> {
  const lock = await activeLock(root);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", command ?? append("pkgs/a/src/x.ts", "// change\n")], {
    stdio: "pipe",
    verifyOptions: { typecheck: false },
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  return { lock, outcome };
}

function reportFor(root: string, lock: VibeCheck, outcome: RunOutcome) {
  return buildReport(root, lock.id, { run: outcome.record, verification: outcome.record.verification });
}

const isStaleBuild = (f: Finding): boolean =>
  f.text.includes("is older than its sources") || f.text.includes("has no build output");

test("stale build: a changed source with older ignored output is named with the package", async () => {
  const root = repoWithPackage({ workspaces: ["pkgs/*"] });
  const { lock, outcome } = await changePackage(root);
  const report = await reportFor(root, lock, outcome);
  const finding = report.findings.find((f) => f.text.startsWith("pkgs/a/dist is older than its sources"));
  assert.ok(finding, JSON.stringify(report.findings));
  assert.equal(finding!.evidenceClass, "asserted");
  assert.equal(
    finding!.text,
    'pkgs/a/dist is older than its sources (the run changed pkgs/a/src/x.ts): an error about "pkg-a" may come from the old build — build it first, or name the build in checks.yaml\'s refresh',
  );
});

test("stale build: output newer than the change means no finding", async () => {
  const root = repoWithPackage({ workspaces: ["pkgs/*"] });
  const { lock, outcome } = await changePackage(root);
  const later = new Date(Date.now() + 60_000);
  for (const rel of ["pkgs/a/dist/index.d.ts", "pkgs/a/dist/index.js"]) {
    fs.utimesSync(path.join(root, rel), later, later);
  }
  const report = await reportFor(root, lock, outcome);
  assert.equal(report.findings.some(isStaleBuild), false, JSON.stringify(report.findings));
});

test("stale build: output that is not ignored is not judged", async () => {
  const root = repoWithPackage({ workspaces: ["pkgs/*"], ignoreDist: false });
  const { lock, outcome } = await changePackage(root);
  const report = await reportFor(root, lock, outcome);
  assert.equal(report.findings.some(isStaleBuild), false, JSON.stringify(report.findings));
});

test("stale build: without workspaces nothing is judged", async () => {
  const root = repoWithPackage();
  const { lock, outcome } = await changePackage(root);
  const report = await reportFor(root, lock, outcome);
  assert.equal(report.findings.some(isStaleBuild), false, JSON.stringify(report.findings));
});

test("stale build: a run that only changes the output is not blamed", async () => {
  const root = repoWithPackage({ workspaces: ["pkgs/*"] });
  const { lock, outcome } = await changePackage(root, append("pkgs/a/dist/index.js", "// rebuilt\n"));
  assert.deepEqual(outcome.record.changed, [], "ignored output is not a project change");
  const report = await reportFor(root, lock, outcome);
  assert.equal(report.findings.some(isStaleBuild), false, JSON.stringify(report.findings));
});

test("stale build: a missing target is named with the package", async () => {
  const root = repoWithPackage({ workspaces: ["pkgs/*"] });
  fs.rmSync(path.join(root, "pkgs/a/dist/index.d.ts"));
  const { lock, outcome } = await changePackage(root);
  const report = await reportFor(root, lock, outcome);
  const finding = report.findings.find((f) => f.text.startsWith("pkgs/a has no build output"));
  assert.ok(finding, JSON.stringify(report.findings));
  assert.ok(finding!.text.includes("dist/index.d.ts"), finding!.text);
  assert.ok(finding!.text.includes('"pkg-a"'), finding!.text);
});
