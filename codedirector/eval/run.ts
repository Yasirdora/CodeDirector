/**
 * Eval harness — a regression gate, not science (see eval/README.md).
 *
 * Each case in eval/cases/*.yaml describes a temp git repo (files), an Intent
 * Lock (YAML fragment), a change command, and expectations. The harness runs
 * the REAL CLI (`cdir run` then `cdir report --format=json`) in the temp repo
 * and scores the run against the expectations:
 *
 *   expect.exitCode               process exit code of `cdir run`
 *   expect.status                 lock status after the run (verified/failed)
 *   expect.violationsContaining[] substrings that must appear in violations
 *   expect.items[]                {match, class, verdict} — some report item whose
 *                                 subject/clauseKind contains `match` must carry
 *                                 exactly this evidence class and verdict
 *   expect.uncheckedMin           minimum size of the Unchecked bucket
 *
 * The gate: any unmet expectation fails the case; any failed case exits
 * non-zero. Case directories are removed on PASS and kept (path printed) on
 * FAIL for debugging.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import YAML from "yaml";
import { IntentLock, LOCK_SCHEMA_VERSION } from "../src/lock/types";
import { saveLock } from "../src/lock/store";
import { EvidenceClass, Verdict } from "../src/verify/types";
import { ChangeReport } from "../src/report/report";

interface ExpectedItem {
  match: string;
  class: EvidenceClass;
  verdict: Verdict;
}

interface EvalExpect {
  exitCode: number;
  status?: string;
  violationsContaining?: string[];
  items?: ExpectedItem[];
  uncheckedMin?: number;
}

interface EvalCase {
  name: string;
  files: Record<string, string>;
  lock: {
    utterance?: string;
    goal?: string;
    interpretation?: string;
    change?: string;
    keep?: IntentLock["keep"];
    deny?: string[];
    verifyCommand?: string;
    budget: { files: string[]; maxFiles?: number; maxLines?: number };
  };
  command: string;
  expect: EvalExpect;
}

const CLAUSES = new Set(["output-unchanged", "api-unchanged", "no-new-dependency", "tests-pass", "custom"]);
const CLASSES = new Set(["proven", "measured", "asserted", "unchecked"]);
const VERDICTS = new Set(["held", "violated", "unchecked"]);

function validateCase(raw: unknown, file: string): EvalCase {
  const c = raw as EvalCase;
  const bad = (msg: string): never => {
    throw new Error(`eval case ${file}: ${msg}`);
  };
  if (!c || typeof c !== "object") bad("top level must be a mapping");
  if (typeof c.name !== "string" || !c.name) bad("missing name");
  if (!c.files || typeof c.files !== "object") bad("missing files mapping");
  if (!c.lock || typeof c.lock !== "object") bad("missing lock mapping");
  if (!Array.isArray(c.lock.budget?.files)) bad("lock.budget.files must be a list");
  for (const k of c.lock.keep ?? []) {
    if (!CLAUSES.has(k?.kind)) bad(`unknown keep kind: ${JSON.stringify(k?.kind)}`);
  }
  if (typeof c.command !== "string" || !c.command) bad("missing command");
  if (!c.expect || typeof c.expect.exitCode !== "number") bad("expect.exitCode must be a number");
  for (const i of c.expect.items ?? []) {
    if (typeof i.match !== "string") bad("expect.items[].match must be a string");
    if (!CLASSES.has(i.class)) bad(`expect.items[].class invalid: ${i.class}`);
    if (!VERDICTS.has(i.verdict)) bad(`expect.items[].verdict invalid: ${i.verdict}`);
  }
  return c;
}

function composeLock(c: EvalCase): IntentLock {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id: "IL-0001",
    status: "active",
    utterance: c.lock.utterance ?? c.name,
    goal: c.lock.goal ?? c.name,
    interpretation: c.lock.interpretation ?? c.name,
    keep: c.lock.keep ?? [],
    deny: c.lock.deny ?? [],
    change: c.lock.change ?? c.name,
    ...(c.lock.verifyCommand !== undefined ? { verifyCommand: c.lock.verifyCommand } : {}),
    budget: {
      files: c.lock.budget.files,
      symbols: [],
      maxFiles: c.lock.budget.maxFiles ?? Math.max(c.lock.budget.files.length, 1),
      maxLines: c.lock.budget.maxLines ?? 400,
    },
    accept: [],
    assumptions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "eval",
  };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=cdir-eval", "-c", "user.email=cdir-eval@local", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
}

interface CaseResult {
  name: string;
  passed: boolean;
  failures: string[];
  tmp: string;
}

function runCase(cliPath: string, c: EvalCase): CaseResult {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-eval-"));
  const failures: string[] = [];
  try {
    for (const [rel, contents] of Object.entries(c.files)) {
      const p = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, contents);
    }
    git(tmp, ["init", "-q"]);
    git(tmp, ["add", "-A"]);
    git(tmp, ["commit", "-qm", "init"]);
    saveLock(tmp, composeLock(c));

    const run = spawnSync("sh", ["-c", `${process.execPath} ${JSON.stringify(cliPath)} run IL-0001 --root ${JSON.stringify(tmp)} -- ${c.command}`], {
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (run.error) {
      failures.push(`cdir run spawn failed: ${run.error.message}`);
      return { name: c.name, passed: false, failures, tmp };
    }
    if (run.status !== c.expect.exitCode) {
      failures.push(`exitCode: expected ${c.expect.exitCode}, got ${run.status}\n  run output tail: ${(run.stdout + run.stderr).split("\n").slice(-8).join(" | ")}`);
    }

    const rep = spawnSync(process.execPath, [cliPath, "report", "IL-0001", "--root", tmp, "--format=json"], {
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (rep.status !== 0 && rep.status !== 1) {
      failures.push(`cdir report failed (exit ${rep.status}): ${rep.stderr.slice(0, 300)}`);
      return { name: c.name, passed: false, failures, tmp };
    }
    let report: ChangeReport;
    try {
      report = JSON.parse(rep.stdout) as ChangeReport;
    } catch (e) {
      failures.push(`report --format=json did not parse: ${e instanceof Error ? e.message : e}`);
      return { name: c.name, passed: false, failures, tmp };
    }

    for (const sub of c.expect.violationsContaining ?? []) {
      if (!report.violations.some((v) => v.includes(sub))) {
        failures.push(`violations missing substring ${JSON.stringify(sub)} — got: ${JSON.stringify(report.violations)}`);
      }
    }
    for (const ei of c.expect.items ?? []) {
      const hit = report.items.find(
        (i) => (i.clauseKind === ei.match || i.subject.includes(ei.match)) && i.evidenceClass === ei.class && i.verdict === ei.verdict,
      );
      if (!hit) {
        failures.push(
          `no item matching {${ei.match}, ${ei.class}, ${ei.verdict}} — got: ` +
            JSON.stringify(report.items.map((i) => [i.subject, i.evidenceClass, i.verdict])),
        );
      }
    }
    if (c.expect.uncheckedMin !== undefined && report.counts.unchecked < c.expect.uncheckedMin) {
      failures.push(`unchecked bucket too small: expected >= ${c.expect.uncheckedMin}, got ${report.counts.unchecked}`);
    }
    if (c.expect.status !== undefined) {
      const lockFile = fs.readdirSync(path.join(tmp, ".codedirector", "locks"))[0];
      const status = (YAML.parse(fs.readFileSync(path.join(tmp, ".codedirector", "locks", lockFile), "utf8")) as IntentLock).status;
      if (status !== c.expect.status) {
        failures.push(`lock status: expected ${c.expect.status}, got ${status}`);
      }
    }
  } catch (e) {
    failures.push(`harness error: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { name: c.name, passed: failures.length === 0, failures, tmp };
}

function main(): number {
  // Case YAMLs are data, not compiled — resolve against the source tree:
  // dist/eval/run.js → <pkg>/eval/cases.
  const casesDir = path.join(__dirname, "..", "..", "eval", "cases");
  const cliPath = path.join(__dirname, "..", "src", "cli.js");
  const files = fs
    .readdirSync(casesDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  if (files.length === 0) {
    process.stderr.write("eval: no cases found in eval/cases/\n");
    return 1;
  }

  const results: CaseResult[] = [];
  for (const f of files) {
    const c = validateCase(YAML.parse(fs.readFileSync(path.join(casesDir, f), "utf8")), f);
    const r = runCase(cliPath, c);
    results.push(r);
    if (r.passed) {
      process.stdout.write(`PASS  ${r.name}\n`);
      fs.rmSync(r.tmp, { recursive: true, force: true });
    } else {
      process.stdout.write(`FAIL  ${r.name}\n`);
      for (const failure of r.failures) process.stdout.write(`      - ${failure}\n`);
      process.stdout.write(`      repo kept at: ${r.tmp}\n`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  process.stdout.write(`\neval: ${passed}/${results.length} cases passed\n`);
  if (passed !== results.length) {
    process.stdout.write(`GATE FAILED — ${results.length - passed} case(s) regressed\n`);
    return 1;
  }
  return 0;
}

process.exit(main());
