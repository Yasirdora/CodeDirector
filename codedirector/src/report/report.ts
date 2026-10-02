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
import {
  changedFiles,
  changedLineCount,
  ClassifiedChange,
  classifyChanges,
  rejudgeRun,
  scopeViolations,
} from "../run/classify";
import { Baseline, baselinesDir, loadTaskBaseline, taskBaselineFileName, taskBaselinePath } from "../run/baseline";
import { verifyLock, VerifyOptions } from "../verify/verify";
import {
  countByClass,
  declaredButUnrunnable,
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
  /** verified = nothing violated · incomplete = judged, but the scope reference is missing · failed otherwise. */
  verdict: "verified" | "failed" | "incomplete";
  /** Which snapshot this report describes: the current tree, or a recorded attempt. */
  view: "current" | "attempt";
  /** The attempt this report is bound to, when one is recorded. */
  attemptId?: string;
  /**
   * The lock that closed this one — its task baseline was captured after
   * this lock's last attempt, so the tree since then is that lock's to
   * answer for. Set when, for that reason, the report shows the last
   * attempt as recorded instead of judging the live tree.
   */
  closedBy?: ClosingLock;
  /** Why the verdict is incomplete (always set when it is). */
  incompleteReason?: string;
  /** Acceptance criteria in words — human-judged; rendered everywhere, gating nothing. */
  accept: string[];
  /** The user's exact words — verbatim, immutable. */
  utterance: string;
  goal: string;
  generatedAt: string;
  command?: string[];
  /** Repo-relative path of the run record this report summarizes. */
  runRecordPath?: string;
  /** Repo-relative path of the reference the scope delta is measured against. */
  baselinePath?: string;
  /** Repo-relative task baseline (the immutable per-lock reference). */
  taskBaselinePath?: string;
  taskBaselineCapturedAt?: string;
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
  /** Render a recorded attempt (1-based, oldest first) instead of the current tree. */
  attempt?: number;
  /** Prebuilt index for findings — otherwise built incrementally. */
  index?: RepoIndex;
  /** Compute incidental findings (default true). */
  findings?: boolean;
}

/** All run records for a lock, oldest first (the filename embeds the attempt id). */
export function listRunRecords(rootDir: string, lockId: string): { record: RunRecord; recordPath: string }[] {
  const dir = runsDir(rootDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${lockId}-`) && f.endsWith(".json"))
    .sort()
    .map((f) => {
      const p = path.join(dir, f);
      return { record: JSON.parse(fs.readFileSync(p, "utf8")) as RunRecord, recordPath: p };
    });
}

/** Latest run record for a lock, or null when none was recorded. */
export function latestRunRecord(rootDir: string, lockId: string): { record: RunRecord; recordPath: string } | null {
  const all = listRunRecords(rootDir, lockId);
  return all.length > 0 ? all[all.length - 1] : null;
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

/** The lock that closed another, and when it started. */
export interface ClosingLock {
  lockId: string;
  /** When its task baseline was captured (ISO 8601). */
  capturedAt: string;
}

/**
 * The lock that closed `lockId`, or null while it is still open.
 *
 * A lock answers for the tree from its task baseline until the next lock
 * starts. "Starts" is a fact in the store, not a guess: another lock's task
 * baseline, captured after this lock's last attempt finished. From then on
 * the live tree holds that lock's work too, and judging this lock against it
 * blames it for changes it never made — a sibling's sealed files read as
 * OUT-OF-BUDGET, a later change as a broken KEEP — and wrote FAILED onto a
 * lock that was verified when it ran.
 *
 * A lock whose own task baseline is the newer one is open again: `cdir lock
 * rebase` is the human pointing it at the present tree. The earliest
 * closing lock is the one named, because that is where this lock's
 * answerability ended.
 *
 * Not covered, and said in the README: two locks running at once (each
 * still sees the other's files), and an edit made between this lock's last
 * attempt and the next lock's start (no report judges it once that lock
 * exists).
 */
export function closingLock(
  rootDir: string,
  lockId: string,
  lastAttempt: Pick<RunRecord, "finishedAt">,
  taskBaseline: Baseline | null,
): ClosingLock | null {
  const since = Math.max(
    Date.parse(lastAttempt.finishedAt),
    taskBaseline ? Date.parse(taskBaseline.capturedAt) : Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(since)) return null; // an unreadable date closes nothing
  const dir = baselinesDir(rootDir);
  if (!fs.existsSync(dir)) return null;

  const suffix = taskBaselineFileName("");
  let closing: ClosingLock | null = null;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(suffix)) continue;
    const other = file.slice(0, -suffix.length);
    if (other === lockId) continue;
    const capturedAt = loadTaskBaseline(rootDir, other)?.capturedAt;
    if (capturedAt === undefined) continue;
    const at = Date.parse(capturedAt);
    if (!(at > since)) continue;
    if (closing === null || at < Date.parse(closing.capturedAt)) closing = { lockId: other, capturedAt };
  }
  return closing;
}

export async function buildReport(
  rootDir: string,
  lockId: string,
  opts: BuildReportOptions = {},
): Promise<ChangeReport> {
  const lock = loadLock(rootDir, lockId);
  if (!lock) throw new ReportError(`no such lock: ${lockId} (see \`cdir lock ls\`)`);

  const taskBaselineFile = taskBaselinePath(rootDir, lockId);
  const taskBaseline = loadTaskBaseline(rootDir, lockId);

  // Which attempt the report is bound to: the explicit one, the live run, or
  // the latest recorded. `--attempt N` renders that attempt as recorded, and
  // so does a lock that a later lock has closed; everything else measures
  // the CURRENT tree and says so.
  let latest: { record: RunRecord; recordPath: string } | null = null;
  if (opts.run) {
    latest = { record: opts.run, recordPath: opts.runRecordPath ?? "" };
  } else if (opts.attempt !== undefined) {
    const all = listRunRecords(rootDir, lockId);
    const chosen = all[opts.attempt - 1];
    if (!chosen) {
      throw new ReportError(
        `no attempt ${opts.attempt} for ${lockId} (${all.length} recorded${all.length === 1 ? "" : "s"})`,
      );
    }
    latest = chosen;
  } else {
    latest = latestRunRecord(rootDir, lockId);
  }
  const run = latest?.record;

  // The live tree is this lock's only until the next lock starts. After
  // that the report is the last attempt as recorded (see closingLock).
  const closedBy = run && !opts.run && opts.attempt === undefined ? closingLock(rootDir, lockId, run, taskBaseline) : null;
  const view: ChangeReport["view"] =
    (opts.attempt !== undefined && !opts.run) || closedBy !== null ? "attempt" : "current";

  // When re-verifying standalone, hold the task baseline to its capture-time
  // hash (baseline tamper detection).
  const integrity =
    !opts.verification && run?.baselineSha256 && run.baselinePath
      ? {
          baselinePath: path.join(rootDir, run.baselinePath),
          expectedBaselineSha256: run.baselineSha256,
        }
      : {};
  // A closed lock's checks are the ones its last attempt recorded. Run
  // again, they would test a tree that holds the later lock's work.
  const recorded: VerificationReport | undefined =
    closedBy !== null && run
      ? (run.verification ?? {
          lockId,
          verifiedAt: run.finishedAt,
          items: [],
          violations: [],
          counts: countByClass([]),
        })
      : undefined;
  const verification = opts.verification ?? recorded ?? (await verifyLock(rootDir, lockId, { ...integrity, ...opts }));
  const runRecordPath = latest?.recordPath
    ? path.isAbsolute(latest.recordPath)
      ? path.relative(rootDir, latest.recordPath).split(path.sep).join("/")
      : latest.recordPath
    : undefined;

  // The scope half of the verdict. A live run already classified against the
  // task baseline; an attempt view re-judges the recorded paths against the
  // Lock as it stands now; the default view recomputes the FULL delta of the
  // current tree against the task baseline — a change made after the run is
  // not invisible to the receipt.
  let changed: ClassifiedChange[] = [];
  let budget: BudgetStats | undefined;
  let scope: string[] = [];
  if (view === "attempt" && run) {
    const rejudged = rejudgeRun(run, lock);
    changed = rejudged.changed;
    budget = rejudged.budget;
    scope = rejudged.violations;
  } else if (opts.run && run) {
    changed = run.changed;
    budget = run.budget;
    scope = run.allowExpand ? [] : scopeViolations(run.changed, run.budget);
  } else if (taskBaseline) {
    changed = classifyChanges(rootDir, lock, taskBaseline);
    const untracked = changedFiles(rootDir, taskBaseline)
      .filter((c) => c.status === "??" || c.status === "!!")
      .map((c) => c.path);
    const linesChanged = changedLineCount(rootDir, untracked, taskBaseline);
    budget = {
      filesChanged: changed.length,
      linesChanged,
      maxFiles: lock.budget.maxFiles,
      maxLines: lock.budget.maxLines,
    };
    // A logged --allow-expand on the latest attempt is the human's recorded
    // acceptance of scope growth; the fresh view carries it over.
    scope = run?.allowExpand ? [] : scopeViolations(changed, budget);
  }

  const items = enforceArtifactRule(verification.items);

  let findings: Finding[] = [];
  if (opts.findings !== false && changed.length > 0) {
    const domains = opts.domains ?? defaultDomains();
    const index = opts.index ?? (await buildIndex(rootDir, { domains })).index;
    findings = computeFindings(index, changed, domains);
  }
  // Always named, whatever else is: files were moved aside.
  findings.push(...(verification.putBack ?? []).map(putBackFinding));

  const unrunnable = declaredButUnrunnable(verification.items);
  const incompleteReason =
    view === "current" && !taskBaseline
      ? `no task baseline for ${lockId} — scope could not be judged; run \`cdir run\` or \`cdir checkpoint ${lockId}\` first`
      : closedBy !== null && run && !run.verification
        ? `the last attempt of ${lockId} recorded no checks, and ${closedBy.lockId} has started since — they cannot be run again on a tree that is no longer this lock's own`
      : unrunnable.length > 0
        ? `declared check(s) could not run: ${unrunnable
            .slice(0, 2)
            .map((i) => `${i.subject} — ${i.reason ?? i.detail}`)
            .join("; ")}${unrunnable.length > 2 ? `; +${unrunnable.length - 2} more` : ""}`
        : undefined;

  const violations = [...scope, ...verification.violations];
  // The recorded command outcome is an attempt's history. It decides the
  // verdict only when this report IS that attempt — an explicit attempt view,
  // or the live run's own report. A current-tree re-verification judges the
  // tree it just measured; otherwise a fixed re-verify kept reading FAILED
  // from the attempt before it (a stale record).
  const boundToRun = view === "attempt" || opts.run !== undefined;
  const commandFailed = boundToRun && run !== undefined && run.exitCode !== 0;
  const verdict: ChangeReport["verdict"] =
    violations.length > 0 || commandFailed
      ? "failed"
      : incompleteReason !== undefined
        ? "incomplete"
        : "verified";

  const counts = countByClass(items);
  counts.asserted += findings.length;

  return {
    schemaVersion: 1,
    lockId: lock.id,
    verdict,
    view,
    utterance: lock.utterance,
    goal: lock.goal,
    accept: lock.accept,
    generatedAt: new Date().toISOString(),
    ...(run ? { command: run.command } : {}),
    ...(run?.attemptId ? { attemptId: run.attemptId } : {}),
    ...(closedBy !== null ? { closedBy } : {}),
    ...(runRecordPath !== undefined ? { runRecordPath } : {}),
    ...(taskBaseline
      ? { taskBaselinePath: path.relative(rootDir, taskBaselineFile).split(path.sep).join("/") }
      : {}),
    ...(taskBaseline ? { taskBaselineCapturedAt: taskBaseline.capturedAt } : {}),
    ...(verification.baselinePath !== undefined ? { baselinePath: verification.baselinePath } : {}),
    changed,
    ...(budget ? { budget } : {}),
    ...(incompleteReason !== undefined ? { incompleteReason } : {}),
    items,
    findings,
    violations,
    counts,
  };
}

/**
 * Persist the report's verdict onto the Lock: verified when everything
 * passed, failed on any violation. `cdir lock show` reflects it.
 *
 * Only a judgment of the live tree is the lock's verdict. A recorded attempt
 * shown again — an old one asked for by number, or the last one of a lock
 * that a later lock has closed — is history: it is rendered, and nothing is
 * written. Decided here, once, for the CLI's report and verify and for the
 * MCP tool alike.
 */
export function finalizeLockStatus(rootDir: string, report: ChangeReport): VibeCheck {
  const lock = loadLock(rootDir, report.lockId);
  if (!lock) throw new ReportError(`no such lock: ${report.lockId}`);
  if (report.view !== "current") return lock;
  lock.status = report.verdict;
  saveLock(rootDir, lock);
  return lock;
}
