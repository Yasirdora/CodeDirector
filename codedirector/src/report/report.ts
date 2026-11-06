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
import { uncommittedAmong } from "../lock/leftovers";
import { BudgetStats, latestRunRecord, listRunRecords, RunRecord } from "../run/run";
import {
  changedFiles,
  changedLineCount,
  ClassifiedChange,
  classifyChanges,
  rejudgeRun,
  requiredCheckViolationsForRun,
  scopeViolations,
} from "../run/classify";
import { Baseline, baselineFileHash, loadTaskBaseline, taskBaselinePath } from "../run/baseline";
import { claimRoot, ClaimError, claimRefusal, describeClaim, readClaim, type ClaimDescription, type ClaimHandle } from "../run/claim";
import { closedReverifyRefusal, closingLock, type ClosingLock } from "../run/closing";
import { sha256Bytes } from "../run/tree";
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
import { staleBuildFindings } from "./stale-build";

// They live beside the run record's type now; callers of this module still find them here.
export { latestRunRecord, listRunRecords };

// The closed-lock question lives beside the run types so a run can ask it
// without importing this module; callers still find it here.
export { closingLock };
export type { ClosingLock };

export class ReportError extends Error {}

/**
 * How a current-tree report got its checks: shown from the last attempt while
 * the tree is exactly that attempt's after-state, or run now because it moved
 * (or because a re-verify was asked for). One line in the report says which.
 */
export interface ChecksSource {
  /** 1-based attempt number, oldest first — the numbering `--attempt` uses. */
  attempt: number;
  /** When that attempt finished (ISO 8601); the checks' own time. */
  at: string;
  /** True = the attempt's recorded checks were shown; false = the checks ran now. */
  reused: boolean;
  /** Why the checks ran now, when they did ("running": another process holds the root). */
  reason?: "reverify" | "tree-changed" | "no-checks" | "no-after-hashes" | "baseline-moved" | "no-baseline" | "running";
}

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
  /** Present on a current-tree report: which checks it shows, and whether they ran. */
  checksFrom?: ChecksSource;
  /**
   * Set while another process holds this root's claim (a run, a verify, or a
   * report re-running the checks): what is running, and where. The report
   * shows the last recorded attempt and runs nothing while it is set.
   */
  running?: ClaimDescription;
  /** A stale claim this report (or the attempt it shows) set aside, said once. */
  staleClaim?: string;
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
  /**
   * Run the checks even when the tree is exactly the latest attempt's own
   * after-state. `cdir verify` always passes this; `cdir report --reverify`
   * and the MCP `reverify: true` input are the explicit request.
   */
  reverify?: boolean;
  /** Prebuilt index for findings — otherwise built incrementally. */
  index?: RepoIndex;
  /** Compute incidental findings (default true). */
  findings?: boolean;
}

/**
 * Incidental observations (blueprint §12 "never perform, record and offer").
 * v1 rule: an in-budget file was modified but no test file references any of
 * its symbols — the change's behavioral coverage is unknown. Asserted.
 *
 * Said only where it can be true. A file the index does not read (Markdown,
 * YAML, a plist) has no symbols to reference, so the sentence is noise
 * there. And for a language with no recognised test file in the index,
 * "no test references it" is false modesty: the truth is that cdir cannot
 * tell, said once for the language — Swift is now recognised by its test
 * targets, so it lands here only when the project has none.
 */
function computeFindings(index: RepoIndex, changed: ClassifiedChange[], domains: DomainRegistry): Finding[] {
  const findings: Finding[] = [];
  const graph = buildGraph(index, domains);
  const testedLanguages = new Set(
    Object.keys(index.files).filter((f) => isTestFile(f, domains)).map(languageOf),
  );
  // A dependency manifest (Package.swift) declares a package: nothing in it
  // is behaviour a test could reference, so it gets no line of its own.
  const manifests = new Set(domains.dependencyManifests().map((m) => path.basename(m.path)));
  const unmapped = new Map<string, string[]>();
  for (const c of changed) {
    if (c.class !== "in-budget" || isTestFile(c.path, domains)) continue;
    if (!index.files[c.path]) continue; // not source cdir reads: nothing to reference
    if (manifests.has(path.basename(c.path))) continue;
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

// ClosingLock and closingLock live in ../run/closing: run/run.ts asks the same
// question before a new attempt, and it must not import this module.

/**
 * The checks an attempt recorded, as they were written down: what `--attempt
 * N` and a closed lock both show. An old record may carry none — the report
 * then says incomplete rather than run today's checks on a tree that is no
 * longer that attempt's own.
 */
function recordedChecks(lockId: string, run: RunRecord): VerificationReport {
  return (
    run.verification ?? {
      lockId,
      verifiedAt: run.finishedAt,
      items: [],
      violations: [],
      counts: countByClass([]),
    }
  );
}

/** sha256 of a repo-relative file, or null when there is no such readable file. */
function hashAt(rootDir: string, relPath: string): string | null {
  try {
    return sha256Bytes(fs.readFileSync(path.join(rootDir, relPath)));
  } catch {
    return null;
  }
}

/** What the live tree is, relative to the last attempt's recorded after-state. */
type AfterStateKind = "same" | "no-checks" | "no-after-hashes" | "baseline-moved" | "no-baseline" | "tree-changed";

/**
 * Whether the tree is exactly the after-state the attempt left.
 *
 * "Exactly" is two facts: every file the attempt is responsible for still
 * holds the bytes the record kept for it (a deleted path is still absent),
 * and the live delta against the task baseline names no file the attempt was
 * not already answerable for. A record without checks or without after-hashes,
 * or a task baseline that has moved since (a rebase, or a tampered file),
 * cannot prove the state and re-verifies as before.
 */
function attemptAfterState(
  rootDir: string,
  run: RunRecord,
  taskBaseline: Baseline | null,
  taskBaselineFile: string,
): AfterStateKind {
  if (!run.verification) return "no-checks";
  const hashes = run.afterHashes;
  if (!hashes) return "no-after-hashes";
  if (!taskBaseline) return "no-baseline";
  // The task baseline is immutable except through `cdir lock rebase`; the
  // record carries the hash it was judged against.
  let baselineNow: string;
  try {
    baselineNow = baselineFileHash(taskBaselineFile);
  } catch {
    return "baseline-moved";
  }
  if (!run.baselineSha256 || run.baselineSha256 !== baselineNow) return "baseline-moved";

  // The attempt answers for what it changed and for whatever its checks left
  // behind (the hashes were taken after the ladder ran).
  const attributable = new Set(Object.keys(hashes));
  for (const c of run.changed) attributable.add(c.path);
  for (const p of attributable) {
    const recorded = hashes[p];
    const current = hashAt(rootDir, p);
    // Deleted paths have no hash: the recorded state is "still absent".
    if (recorded === undefined ? current !== null : current !== recorded) return "tree-changed";
  }
  for (const c of changedFiles(rootDir, taskBaseline)) {
    if (!attributable.has(c.path)) return "tree-changed";
  }
  return "same";
}

/**
 * The verdict word the lock's status was written from, read back from the run
 * record: failed on a non-zero command or a violation, incomplete when a
 * declared check could not run, verified otherwise.
 */
function recordedVerdict(run: RunRecord): "verified" | "failed" | "incomplete" {
  if (run.exitCode !== 0 || run.violations.length > 0) return "failed";
  return declaredButUnrunnable(run.verification?.items ?? []).length > 0 ? "incomplete" : "verified";
}

/** The claim a re-verifying report needs, or the refusal a second process deserves. */
function openReportClaim(rootDir: string, lockId: string, command: string | undefined): ClaimHandle {
  try {
    return claimRoot(rootDir, { kind: "report", lockId, command: command ?? "report", phase: "checking the tree" });
  } catch (e) {
    if (e instanceof ClaimError) throw new ReportError(e.message);
    throw e;
  }
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

  // What another process is doing with this root right now — read always.
  // While a claim is live nothing here runs the checks behind it, and the
  // report says what is running before anything else.
  const claimView = readClaim(rootDir);
  const claimed = claimView !== null && claimView.state !== "stale" ? claimView : null;
  const running: ClaimDescription | undefined = claimed
    ? {
        kind: claimed.claim.kind,
        lockId: claimed.claim.lockId,
        attempt: claimed.claim.attempt,
        pid: claimed.claim.pid,
        startedAt: claimed.claim.startedAt,
        phase: claimed.claim.phase,
        phaseSince: claimed.claim.phaseSince,
      }
    : undefined;

  // The live tree is this lock's only until the next lock starts. After
  // that the report is the last attempt as recorded (see closingLock).
  const closedBy = run && !opts.run && opts.attempt === undefined ? closingLock(rootDir, lockId, run, taskBaseline) : null;
  const view: ChangeReport["view"] =
    (opts.attempt !== undefined && !opts.run) || closedBy !== null ? "attempt" : "current";

  // An explicit re-verify of a closed lock is refused: the checks would run
  // against a tree that now holds the next lock's work, and anything they
  // found would be written back as this lock's verdict. Refused before the
  // claim is taken and before anything runs.
  if (
    opts.reverify === true &&
    opts.run === undefined &&
    opts.attempt === undefined &&
    opts.verification === undefined &&
    closedBy !== null
  ) {
    const lastAttempt =
      run !== undefined && run.attemptId !== undefined
        ? { attemptId: run.attemptId, verdict: recordedVerdict(run) }
        : null;
    throw new ReportError(closedReverifyRefusal(lockId, closedBy, lastAttempt));
  }

  // The last attempt's checks are shown without running them again only while
  // the tree is exactly that attempt's after-state. A moved tree, a record
  // that cannot prove its state, or a rebased baseline is verified as before.
  const mayReuse =
    view === "current" && !opts.run && opts.verification === undefined && opts.reverify !== true;
  let afterState: AfterStateKind | undefined;
  if (mayReuse && run) {
    try {
      afterState = attemptAfterState(rootDir, run, taskBaseline, taskBaselineFile);
    } catch {
      afterState = "tree-changed"; // unreadable tree: judge it again
    }
  }
  const reuse = afterState === "same";

  // Another process holds the root. An explicit re-verify is refused (it
  // asked for checks that must not run behind a claim); every other report
  // shows the last recorded attempt, as the attempt view does.
  const busy = claimed !== null && view === "current" && !opts.run && opts.verification === undefined;
  if (busy && claimed !== null && opts.reverify === true) throw new ReportError(claimRefusal(claimed));

  // When re-verifying standalone, hold the task baseline to its capture-time
  // hash (baseline tamper detection).
  const integrity =
    !opts.verification && run?.baselineSha256 && run.baselinePath
      ? {
          baselinePath: path.join(rootDir, run.baselinePath),
          expectedBaselineSha256: run.baselineSha256,
        }
      : {};
  // An attempt view shows the checks that attempt recorded — the same rule
  // for `--attempt N` and for a lock a later lock has closed. Run again,
  // they would test a tree that is no longer that attempt's own.
  const recorded: VerificationReport | undefined =
    run && (view === "attempt" || reuse || busy) ? recordedChecks(lockId, run) : undefined;
  // The checks: given, recorded, or run now. Running them takes the root's
  // claim — a report that re-verifies is work on the tree. Behind a live
  // claim nothing runs, and an empty set says so.
  let verification: VerificationReport;
  let claimStale: string | undefined;
  if (opts.verification !== undefined) {
    verification = opts.verification;
  } else if (recorded !== undefined) {
    verification = recorded;
  } else if (busy) {
    verification = { lockId, verifiedAt: new Date().toISOString(), items: [], violations: [], counts: countByClass([]) };
  } else {
    const claim = openReportClaim(rootDir, lockId, lock.verifyCommand);
    try {
      verification = await verifyLock(rootDir, lockId, { ...integrity, ...opts });
    } finally {
      claim.release();
    }
    claimStale = claim.stale;
  }
  const staleClaim = claimStale ?? run?.staleClaim;
  const runRecordPath = latest?.recordPath
    ? path.isAbsolute(latest.recordPath)
      ? path.relative(rootDir, latest.recordPath).split(path.sep).join("/")
      : latest.recordPath
    : undefined;

  // Which checks this current-tree report shows — said in one line, so a
  // reused attempt and a fresh run can never be mistaken for each other.
  let checksFrom: ChecksSource | undefined;
  if (view === "current" && !opts.run && opts.verification === undefined && run) {
    const all = listRunRecords(rootDir, lockId);
    const index = all.findIndex((r) =>
      latest?.recordPath
        ? r.recordPath === latest.recordPath
        : r.record.attemptId !== undefined && r.record.attemptId === run.attemptId,
    );
    if (index !== -1) {
      const reason: ChecksSource["reason"] =
        opts.reverify === true
          ? "reverify"
          : busy
            ? "running"
            : afterState !== undefined && afterState !== "same"
              ? afterState
              : "tree-changed";
      checksFrom = {
        attempt: index + 1,
        at: run.finishedAt,
        reused: reuse,
        ...(reuse ? {} : { reason }),
      };
    }
  }

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

  // The required checks are judged on whatever `changed` holds, as the
  // lock's verifyCommand stands, and --allow-expand does not excuse them. A
  // closed lock is history, as above: today's rules are not applied to it.
  const checks =
    closedBy === null ? requiredCheckViolationsForRun(rootDir, changed, lock.verifyCommand, taskBaseline) : [];

  const items = enforceArtifactRule(verification.items);

  let findings: Finding[] = [];
  if (opts.findings !== false && changed.length > 0) {
    const domains = opts.domains ?? defaultDomains();
    const index = opts.index ?? (await buildIndex(rootDir, { domains })).index;
    findings = [...computeFindings(index, changed, domains), ...staleBuildFindings(rootDir, changed)];
  }
  // Always named, whatever else is: files were moved aside.
  findings.push(...(verification.putBack ?? []).map(putBackFinding));

  const unrunnable = declaredButUnrunnable(verification.items);
  // An attempt whose record carries no checks is incomplete, never a fresh
  // run: a closed lock names the lock that took the tree over, `--attempt N`
  // names the attempt.
  const incompleteReason =
    busy && recorded === undefined && running !== undefined
      ? `${describeClaim(running)} — its checks are not recorded yet; follow it with \`cdir report ${lockId}\``
      : view === "current" && !taskBaseline
      ? `no task baseline for ${lockId} — scope could not be judged; run \`cdir run\` or \`cdir checkpoint ${lockId}\` first`
      : view === "attempt" && run && !run.verification
        ? closedBy !== null
          ? `the last attempt of ${lockId} recorded no checks, and ${closedBy.lockId} has started since — they cannot be run again on a tree that is no longer this lock's own`
          : `attempt ${opts.attempt} of ${lockId} recorded no checks — showing an attempt does not run them again on today's tree`
      : unrunnable.length > 0
        ? `declared check(s) could not run: ${unrunnable
            .slice(0, 2)
            .map((i) => `${i.subject} — ${i.reason ?? i.detail}`)
            .join("; ")}${unrunnable.length > 2 ? `; +${unrunnable.length - 2} more` : ""}`
        : undefined;

  const violations = [...scope, ...checks, ...verification.violations];
  // The recorded command outcome is an attempt's history. It decides the
  // verdict only when this report IS that attempt — an explicit attempt view,
  // or the live run's own report. A current-tree re-verification judges the
  // tree it just measured; otherwise a fixed re-verify kept reading FAILED
  // from the attempt before it (a stale record).
  const boundToRun = view === "attempt" || opts.run !== undefined || reuse || busy;
  const commandFailed = boundToRun && run !== undefined && run.exitCode !== 0;
  const verdict: ChangeReport["verdict"] =
    violations.length > 0 || commandFailed
      ? "failed"
      : incompleteReason !== undefined
        ? "incomplete"
        : "verified";

  // Notes about the work, never about the verdict (a Finding is asserted).
  // The report that ends a live run does not ask: its files are uncommitted
  // by definition. A later report does.
  if (verdict === "verified" && view === "current" && !opts.run) {
    const uncommitted = uncommittedAmong(rootDir, changed.map((c) => c.path));
    if (uncommitted.length > 0) {
      findings.push({
        text: `Verified, not committed yet: ${uncommitted.length} file(s) — commit them with the lock's records.`,
        evidenceClass: "asserted",
      });
    }
  }
  // A patch applied from the wrong folder skips every file and still exits 0.
  if (run?.exitCode === 0 && changed.length === 0) {
    findings.push({
      text:
        "The command changed no file. If it should have, the run proves nothing about the change " +
        "(a patch applied from the wrong folder is skipped silently).",
      evidenceClass: "asserted",
    });
  }

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
    ...(running !== undefined ? { running } : {}),
    ...(staleClaim !== undefined ? { staleClaim } : {}),
    ...(runRecordPath !== undefined ? { runRecordPath } : {}),
    ...(checksFrom !== undefined ? { checksFrom } : {}),
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
  // Nothing was measured here: another process holds the root, so its claim —
  // not this old reading — decides the lock's status.
  if (report.running) return lock;
  // A lock closed by `cdir lock abandon` stays closed, whatever a report finds.
  if (lock.status === "abandoned") return lock;
  lock.status = report.verdict;
  saveLock(rootDir, lock);
  return lock;
}
