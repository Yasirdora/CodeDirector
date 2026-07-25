/**
 * Change Report tests: content contract (utterance verbatim, classifications,
 * artifact references, Unchecked bucket always visible, findings labeled
 * asserted, footer counts), the schema-enforced artifact downgrade rule,
 * status transitions, and the three output formats.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { loadLock, saveLock } from "../src/lock/store";
import { IntentLock, KeepClause } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { buildReport, finalizeLockStatus } from "../src/report/report";
import { formatReport, formatReportJson, formatReportMarkdown } from "../src/report/format";
import { enforceArtifactRule, VerificationItem } from "../src/verify/types";
import { stableStringify } from "../src/core/store";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;
const append = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

const FILES = {
  "src/math.js": `export function add(a, b) { return a + b; }\n`,
  "src/untested.js": `export function shout(s) { return s.toUpperCase(); }\n`,
  "test/math.test.js":
    `import test from "node:test";\nimport assert from "node:assert/strict";\n` +
    `import { add } from "../src/math.js";\ntest("add works", () => assert.equal(add(2, 3), 5));\n`,
};

async function setup(keep: KeepClause[], customize?: (lock: IntentLock) => void): Promise<{ root: string; lock: IntentLock }> {
  const root = makeGitRepo(FILES);
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make math faster", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  lock.keep = keep;
  lock.budget = { files: ["src/math.js", "src/untested.js"], symbols: [], maxFiles: 3, maxLines: 400 };
  lock.change = "math internals only";
  lock.goal = "same behavior, faster";
  customize?.(lock);
  lock.status = "active";
  saveLock(root, lock);
  return { root, lock };
}

test("report: full content contract on a clean run", async () => {
  const { root, lock } = await setup([
    { kind: "api-unchanged", symbols: ["src/math.js#add"] },
    { kind: "tests-pass", glob: "test/*.test.js" },
    { kind: "custom", text: "code stays readable" },
  ]);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// faster\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0);

  const report = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    run: outcome.record,
    runRecordPath: outcome.recordPath,
  });

  assert.equal(report.verdict, "verified");
  assert.equal(report.utterance, "make math faster", "utterance verbatim");
  assert.equal(report.changed.length, 1);
  assert.equal(report.changed[0].class, "in-budget");
  assert.ok(report.budget, "budget present");
  assert.ok(report.items.every((i) => i.verdict !== "held" || i.evidenceClass === "asserted" || i.artifactRef),
    "every held claim carries an artifact reference");
  assert.ok(report.counts.unchecked >= 1, "custom clause in the unchecked bucket");
  assert.equal(report.counts.proven, 1);
  assert.equal(report.counts.measured, 1);

  const text = formatReport(report);
  assert.ok(text.includes(`Said   "make math faster"`));
  assert.ok(text.includes("verdict: VERIFIED"));
  assert.ok(text.includes("Violations: none"));
  assert.ok(/Unchecked \(\d+\)/.test(text), "unchecked bucket visible");
  assert.ok(text.includes("human judges"), "unchecked reason visible");
  assert.ok(text.includes("Counts: proven 1 · measured 1"), "footer counts");
  assert.ok(text.includes("artifact:"), "artifact references rendered");
});

test("report: violations first, and a failed verdict updates the lock", async () => {
  const { root, lock } = await setup([
    { kind: "api-unchanged", symbols: ["src/math.js#add"] },
    { kind: "tests-pass", glob: "test/*.test.js" },
  ]);
  const breakSig =
    'const fs=require("fs");fs.writeFileSync("src/math.js",fs.readFileSync("src/math.js","utf8").replace("add(a, b)","add(a, b, c)"))';
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", breakSig], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 1);

  const report = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    run: outcome.record,
    runRecordPath: outcome.recordPath,
  });
  assert.equal(report.verdict, "failed");
  assert.ok(report.violations.length > 0);

  // violations render before held claims
  const text = formatReport(report);
  const vIdx = text.indexOf("Violations (");
  const checksIdx = text.indexOf("Checks (violations first):");
  const firstViolated = text.indexOf("✗", checksIdx);
  const firstHeld = text.indexOf("✓", checksIdx);
  assert.ok(vIdx !== -1 && checksIdx !== -1 && firstViolated !== -1);
  assert.ok(firstViolated < firstHeld, "violated items render before held items");

  finalizeLockStatus(root, report);
  assert.equal(loadLock(root, lock.id)!.status, "failed");
});

test("report: the artifact rule downgrades held claims without a reference", () => {
  const items: VerificationItem[] = [
    { source: "keep-clause", clauseKind: "api-unchanged", subject: "api-unchanged · x", verdict: "held", evidenceClass: "proven", detail: "signature unchanged: x" },
    { source: "keep-clause", clauseKind: "tests-pass", subject: "tests-pass · t", verdict: "held", evidenceClass: "measured", detail: "tests pass", artifactRef: "node --test t → exit 0" },
    { source: "keep-clause", clauseKind: "api-unchanged", subject: "api-unchanged · y", verdict: "violated", evidenceClass: "proven", detail: "signature changed: y" },
  ];
  const enforced = enforceArtifactRule(items);
  assert.equal(enforced[0].evidenceClass, "asserted", "held claim without artifactRef downgraded");
  assert.ok(enforced[0].detail.includes("downgraded to Asserted"));
  assert.equal(enforced[1].evidenceClass, "measured", "held claim WITH artifactRef keeps its class");
  assert.equal(enforced[2].evidenceClass, "proven", "violations are not downgraded (the check ran)");
});

test("report: findings — in-budget file without test coverage is asserted, labeled", async () => {
  const { root, lock } = await setup([]);
  const cmd = append("src/math.js", "// a\n") + ";" + append("src/untested.js", "// b\n");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", cmd], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0);

  const report = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    run: outcome.record,
    runRecordPath: outcome.recordPath,
  });
  const finding = report.findings.find((f) => f.text.includes("src/untested.js"));
  assert.ok(finding, "finding for the untested file");
  assert.equal(finding!.evidenceClass, "asserted");
  assert.ok(!report.findings.some((f) => f.text.includes("src/math.js")), "covered file produces no finding");
  assert.ok(report.counts.asserted >= 1, "findings counted as asserted");

  const text = formatReport(report);
  assert.ok(text.includes("Findings (asserted"), "findings section labeled asserted");
});

test("report: formats — markdown is PR-postable, json is deterministic", async () => {
  const { root, lock } = await setup([{ kind: "tests-pass", glob: "test/*.test.js" }]);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  const report = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    run: outcome.record,
    runRecordPath: outcome.recordPath,
  });

  const md = formatReportMarkdown(report);
  assert.ok(md.startsWith(`# Change Report · ${lock.id}`));
  assert.ok(md.includes("| result | evidence | check | detail | artifact |"), "checks table");
  assert.ok(md.includes("## Unchecked"), "unchecked section always present");
  assert.ok(md.includes("> \"make math faster\""), "utterance quoted");

  const json = formatReportJson(report);
  assert.deepEqual(JSON.parse(json), JSON.parse(stableStringify(report)));
  assert.equal(json, formatReportJson(report), "byte-stable");
  const parsed = JSON.parse(json);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.lockId, lock.id);
});

test("report: empty unchecked bucket is still rendered, not silent", async () => {
  const { root, lock } = await setup([{ kind: "tests-pass", glob: "test/*.test.js" }]);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  const report = await buildReport(root, lock.id, {
    verification: outcome.record.verification,
    run: outcome.record,
    runRecordPath: outcome.recordPath,
  });
  const text = formatReport(report);
  assert.ok(/Unchecked/.test(text), "unchecked bucket always rendered");
  const tc = report.items.find((i) => i.source === "typecheck");
  assert.ok(tc && tc.verdict === "unchecked", "JS repo without tsconfig names the skipped typecheck rung");
});

test("report: standalone buildReport (no run) re-verifies and reports verification-only", async () => {
  const { root, lock } = await setup([{ kind: "tests-pass", glob: "test/*.test.js" }]);
  // no run at all — no baseline, no record
  const report = await buildReport(root, lock.id);
  assert.equal(report.command, undefined);
  assert.ok(!report.runRecordPath);
  assert.equal(report.changed.length, 0);
  const text = formatReport(report);
  assert.ok(text.includes("no run record — verification only"));
  // tests still ran (self-contained), so the claim is measured
  assert.equal(report.counts.measured, 1);
});

test("report: verifyCommand round-trips through the lock YAML", async () => {
  const { root, lock } = await setup([], (l) => {
    l.verifyCommand = "npm test";
  });
  const loaded = loadLock(root, lock.id)!;
  assert.equal(loaded.verifyCommand, "npm test");
});
