/**
 * The Change Report (blueprint §14) — the product's signature artifact.
 *
 * Content contract:
 *  - the Lock's id and the original utterance, verbatim and immutable;
 *  - changed files with their classification (in-budget / out-of-budget /
 *    denied) and the budget they were measured against;
 *  - every KEEP clause and lock-level check with its verdict, its evidence
 *    class, and an artifact reference (which baseline file, which command,
 *    which exit code);
 *  - violations first, then verified-held claims, then the Unchecked bucket
 *    — always visible, each item with its reason;
 *  - findings: incidental observations, Asserted and labeled as such;
 *  - a footer with counts per evidence class.
 *
 * Schema law (§14/§22): a claim without an artifact reference is
 * automatically Asserted. Enforced here by enforceArtifactRule — the report
 * builder downgrades any held claim that lacks an artifactRef.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RepoIndex } from "../core/types";
import { buildIndex } from "../core/builder";
import { buildGraph, isTestFile, testFilesFor } from "../core/graph";
import { defaultDomains, DomainRegistry } from "../domain/registry";
import { VibeCheck } from "../lock/types";
import { languageOf } from "../lock/draft";
import { loadLock, saveLock } from "../lock/store";
import { BudgetStats, RunRecord, runsDir } from "../run/run";
import { ClassifiedChange, rejudgeRun } from "../run/classify";
import { verifyLock, VerifyOptions } from "../verify/verify";
import {
  countByClass,
  EvidenceClass,
  enforceArtifactRule,
  ProbePutBack,
  VerificationItem,
  VerificationReport,
} from "../verify/types";

export class ReportError extends Error {}

export interface Finding {
  text: string;
  /** Findings are incidental observations — always Asserted, always labeled. */
  evidenceClass: "asserted";
  artifactRef?: string;
}

export interface ChangeReport {
  schemaVersion: 1;
  lockId: string;
  /** verified = no violations and the command succeeded · failed otherwise. */
  verdict: "verified" | "failed";
  /** The user's exact words — verbatim, immutable. */
  utterance: string;
  goal: string;
  generatedAt: string;
  command?: string[];
  /** Repo-relative path of the run record this report summarizes. */
  runRecordPath?: string;
  baselinePath?: string;
  changed: ClassifiedChange[];
  budget?: BudgetStats;
  /** All checked claims, artifact-rule already enforced. */
  items: VerificationItem[];
  findings: Finding[];
  violations: string[];
  /** Claims + findings per evidence class (all four keys always present). */
  counts: Record<EvidenceClass, number>;
}

export interface BuildReportOptions extends VerifyOptions {
  /** Precomputed verification (e.g. from `cdir run`) — otherwise re-run. */
  verification?: VerificationReport;
  /** Precomputed run record — otherwise the latest record for the lock. */
  run?: RunRecord;
  runRecordPath?: string;
  /** Prebuilt index for findings — otherwise built incrementally. */
  index?: RepoIndex;
  /** Compute incidental findings (default true). */
  findings?: boolean;
}

/** Latest run record for a lock (by filename, which embeds the timestamp). */
export function latestRunRecord(rootDir: string, lockId: string): { record: RunRecord; recordPath: string } | null {
  const dir = runsDir(rootDir);
  if (!fs.existsSync(dir)) return null;
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${lockId}-`) && f.endsWith(".json"))
    .sort();
  if (matches.length === 0) return null;
  const p = path.join(dir, matches[matches.length - 1]);
  return { record: JSON.parse(fs.readFileSync(p, "utf8")) as RunRecord, recordPath: p };
}

/**
 * Incidental observations (blueprint §12 "never perform, record and offer").
 * v1 rule: an in-budget file was modified but no test file references any of
 * its symbols — the change's behavioral coverage is unknown. Asserted.
 *
 * Said only where it can be true. A file the index does not read (Markdown,
 * YAML, a plist) has no symbols to reference, so the sentence is noise
 * there. And for a language whose tests cdir cannot recognise at all —
 * Swift, until its test mapping exists — "no test references it" is false
 * modesty: the truth is that cdir cannot tell, said once for the language.
 */
function computeFindings(index: RepoIndex, changed: ClassifiedChange[], domains: DomainRegistry): Finding[] {
  const findings: Finding[] = [];
  const graph = buildGraph(index, domains);
  const testedLanguages = new Set(
    Object.keys(index.files).filter((f) => isTestFile(f, domains)).map(languageOf),
  );
  const unmapped = new Map<string, string[]>();
  for (const c of changed) {
    if (c.class !== "in-budget" || isTestFile(c.path, domains)) continue;
    if (!index.files[c.path]) continue; // not source cdir reads: nothing to reference
    const language = languageOf(c.path);
    if (!testedLanguages.has(language)) {
      unmapped.set(language, [...(unmapped.get(language) ?? []), c.path]);
      continue;
    }
    const covering = new Set<string>();
    for (const sym of graph.symbols.values()) {
      if (sym.file !== c.path) continue;
      for (const t of testFilesFor(index, sym, domains)) covering.add(t);
    }
    if (covering.size === 0) {
      findings.push({
        text: `${c.path} changed in-budget, but no test file references its symbols — behavioral coverage unknown`,
        evidenceClass: "asserted",
      });
    }
  }
  for (const [language, paths] of [...unmapped.entries()].sort()) {
    const named = paths.length <= 3 ? ` (${paths.join(", ")})` : "";
    findings.push({
      text: `${paths.length} ${language} file(s) changed in-budget${named}; cdir recognises no ${language} test files here, so their test coverage is unknown`,
      evidenceClass: "asserted",
    });
  }
  return findings;
}

/**
 * A probe changed or added files, and they were put back. Named, because a
 * probe can't tell its own writes from another session's: if someone was
 * editing those files during the check, their version is in the kept folder.
 */
export function putBackFinding(p: ProbePutBack): Finding {
  const list = (files: string[]) => files.slice(0, 5).join(", ") + (files.length > 5 ? ` and ${files.length - 5} more` : "");
  const parts = [
    ...(p.restored.length > 0 ? [`changed ${p.restored.length} file(s), put back as they were: ${list(p.restored)}`] : []),
    ...(p.removed.length > 0 ? [`added ${p.removed.length} file(s), removed: ${list(p.removed)}`] : []),
  ];
  return {
    text:
      `${p.probe} ${parts.join("; it ")}.` +
      (p.keptIn ? ` The versions it left are in ${p.keptIn}/ — if another session edited these files during the check, its work is there.` : ""),
    evidenceClass: "asserted",
    ...(p.keptIn ? { artifactRef: p.keptIn } : {}),
  };
}

export async function buildReport(
  rootDir: string,
  lockId: string,
  opts: BuildReportOptions = {},
): Promise<ChangeReport> {
  const lock = loadLock(rootDir, lockId);
  if (!lock) throw new ReportError(`no such lock: ${lockId} (see \`cdir lock ls\`)`);

  const latest = opts.run ? { record: opts.run, recordPath: opts.runRecordPath } : latestRunRecord(rootDir, lockId);
  // When re-verifying standalone, verify against the run's own baseline and
  // enforce its capture-time hash (baseline tamper detection).
  const integrity =
    !opts.verification && latest?.record.baselineSha256 && latest.record.baselinePath
      ? {
          baselinePath: path.join(rootDir, latest.record.baselinePath),
          expectedBaselineSha256: latest.record.baselineSha256,
        }
      : {};
  const verification = opts.verification ?? (await verifyLock(rootDir, lockId, { ...integrity, ...opts }));
  const run = latest?.record;
  const runRecordPath = latest?.recordPath
    ? path.isAbsolute(latest.recordPath)
      ? path.relative(rootDir, latest.recordPath).split(path.sep).join("/")
      : latest.recordPath
    : undefined;

  // THE REJUDGE. A standalone verify or report judges the recorded change
  // against the Lock as it stands now, rather than reprinting the verdict
  // stored when the command ran. Without this, raising a ceiling and
  // re-verifying still reported the ceiling the run was refused by, and the
  // only remedy was reverting the work and applying it again.
  //
  // Never on a live run (`opts.run`): that classified against this same Lock
  // moments ago, and re-deriving it would say the same thing more slowly.
  const rejudged = !opts.run && run ? rejudgeRun(run, lock) : undefined;

  const items = enforceArtifactRule(verification.items);

  let findings: Finding[] = [];
  if (opts.findings !== false && run && run.changed.length > 0) {
    const domains = opts.domains ?? defaultDomains();
    const index = opts.index ?? (await buildIndex(rootDir, { domains })).index;
    findings = computeFindings(index, run.changed, domains);
  }
  // Always named, whatever else is: files were moved aside.
  findings.push(...(verification.putBack ?? []).map(putBackFinding));

  const violations = rejudged
    ? [...rejudged.violations, ...verification.violations]
    : run
      ? run.violations
      : verification.violations;
  const verdict: ChangeReport["verdict"] =
    violations.length > 0 || (run !== undefined && run.exitCode !== 0) ? "failed" : "verified";

  const counts = countByClass(items);
  counts.asserted += findings.length;

  return {
    schemaVersion: 1,
    lockId: lock.id,
    verdict,
    utterance: lock.utterance,
    goal: lock.goal,
    generatedAt: new Date().toISOString(),
    ...(run ? { command: run.command } : {}),
    ...(runRecordPath !== undefined ? { runRecordPath } : {}),
    ...(verification.baselinePath !== undefined ? { baselinePath: verification.baselinePath } : {}),
    changed: rejudged?.changed ?? run?.changed ?? [],
    ...(rejudged ? { budget: rejudged.budget } : run ? { budget: run.budget } : {}),
    items,
    findings,
    violations,
    counts,
  };
}

/**
 * Persist the report's verdict onto the Lock: verified when everything
 * passed, failed on any violation. `cdir lock show` reflects it.
 */
export function finalizeLockStatus(rootDir: string, report: ChangeReport): VibeCheck {
  const lock = loadLock(rootDir, report.lockId);
  if (!lock) throw new ReportError(`no such lock: ${report.lockId}`);
  lock.status = report.verdict;
  saveLock(rootDir, lock);
  return lock;
}
