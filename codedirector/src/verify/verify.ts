/**
 * The verification ladder (blueprint §17), applied after a change:
 *
 *   1. Structural (proven)   — api-unchanged signature hashes and
 *                              no-new-dependency manifest hashes diffed
 *                              against the pre-captured baseline.
 *   1b. Refresh (measured)   — the rules file's `refresh:` commands, run
 *                              before any after-check reads generated output.
 *   2. Typecheck (proven)    — every compiler-diagnostics check a domain
 *                              describes (`tsc --noEmit` today) when it
 *                              applies and its compiler is available;
 *                              otherwise Unchecked with the reason named.
 *                              Only diagnostics absent from the baseline are
 *                              the run's.
 *   3. Tests (measured)      — each tests-pass glob run through the
 *                              registered test runner (`node --test`); a
 *                              Lock-level verifyCommand ("npm test", ...)
 *                              executed the same way.
 *   4. Output (measured)     — output-unchanged commands re-run; stdout
 *                              sha256 compared to the baseline capture.
 *   5. Custom (unchecked)    — always "human judges". This honesty is the
 *                              feature, per the blueprint.
 *
 * Domains describe the checks (what to run, how to read it); this module
 * runs every one of them — isolated, under timeouts, against the baseline —
 * and assigns every evidence class.
 *
 * Read-only by construction: this module writes nothing to the repository
 * (the index refresh writes only .codedirector/, our own metadata area).
 * The commands being probed run with normal repo permissions — a fully
 * sandboxed verifier is a later phase. The refresh rung is the deliberate
 * exception: its commands write generated output, and the rung names every
 * changed file that is not ignored.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { RepoIndex } from "../core/types";
import { buildIndex } from "../core/builder";
import { buildGraph } from "../core/graph";
import { VibeCheck, DEFAULT_VERIFY_TIMEOUT_MS } from "../lock/types";
import { loadLock } from "../lock/store";
import { sealViolation } from "../lock/seal";
import { signatureHash } from "../lock/check";
import { matchPath } from "../lock/glob";
import { loadChecks } from "../config/checks";
import { appearedManifests, Baseline, baselineFileHash, loadBaseline, taskBaselinePath } from "../run/baseline";
import { probeArtifactRef, probeExcerpt, runArgvProbe, runShellProbe, type ProbeResult } from "../run/probe";
import { gitToAbsRel, runIsolated, sha256Bytes } from "../run/tree";
import { diagnosticsExcerpt, newDiagnostics, probeDiagnostics } from "../run/diagnostics";
import { CORE_SKIP_DIRS } from "../core/walk";
import { defaultDomains, DomainRegistry } from "../domain/registry";
import type { DiagnosticsCheck } from "../domain/types";
import { takeTurn } from "./turns";
import { claimRoot, ClaimError, phaseFor, type ClaimHandle } from "../run/claim";
import {
  countByClass,
  ProbePutBack,
  VerificationItem,
  VerificationReport,
} from "./types";
import { failedTestLabels, formatFailedTests, readFailedTests } from "./failedTests";

export class VerifyError extends Error {}

export interface VerifyOptions {
  /** Explicit baseline path; default is the latest baseline for the lock. */
  baselinePath?: string;
  /** Run the typecheck rung (default true). */
  typecheck?: boolean;
  /** Compiler-check timeout (default: each check's own — 120s for tsc). */
  typecheckTimeoutMs?: number;
  /**
   * Per-test-run and verifyCommand timeout (default: lock.verifyTimeoutMs; a
   * lock that carries a verifyCommand without one gets DEFAULT_VERIFY_TIMEOUT_MS,
   * never a silent 60s).
   */
  testTimeoutMs?: number;
  /** Per-output-command timeout (default 30s). */
  outputTimeoutMs?: number;
  /** Environment for spawned checks (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * sha256 the baseline file had at capture time (from the run record).
   * When provided, verify re-hashes the baseline and, on mismatch, marks
   * every baseline-dependent check unchecked — "baseline modified during
   * execution — run invalid" — and fails. (An agent command executed by
   * `cdir run` could otherwise edit the baseline and fake "held".)
   */
  expectedBaselineSha256?: string;
  /**
   * Collects what each probe changed and had put back. verifyWithBaseline
   * makes one when none is given; a run passes the baseline's in, so the
   * report names both.
   */
  putBack?: ProbePutBack[];
  /** Domains whose checks and manifests are verified (default: the built-in ones). */
  domains?: DomainRegistry;
}

const TAMPER_REASON = "baseline modified during execution — run invalid";
const BASELINE_DEPENDENT_KINDS = new Set(["api-unchanged", "no-new-dependency", "output-unchanged"]);

/** Re-hash the baseline file and compare against the capture-time hash. */
function baselineTampered(rootDir: string, baselineRel: string | undefined, opts: VerifyOptions): boolean {
  if (!opts.expectedBaselineSha256 || !baselineRel) return false;
  try {
    return baselineFileHash(path.join(rootDir, baselineRel)) !== opts.expectedBaselineSha256;
  } catch {
    return true; // baseline file unreadable — treat as tampered
  }
}

/** Repo-relative files matching a glob, deterministic order, never entering skipDirs. */
function expandGlob(rootDir: string, glob: string, skipDirs: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") && e.name !== ".") {
        if (skipDirs.has(e.name) || e.isDirectory()) continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(full);
      } else {
        const rel = path.relative(rootDir, full).split(path.sep).join("/");
        if (matchPath(glob, rel)) out.push(rel);
      }
    }
  };
  walk(rootDir);
  return out.sort();
}

function uncheckedItem(
  source: VerificationItem["source"],
  subject: string,
  reason: string,
  clauseKind?: VerificationItem["clauseKind"],
): VerificationItem {
  return { source, clauseKind, subject, verdict: "unchecked", evidenceClass: "unchecked", detail: reason, reason };
}

// ---------------------------------------------------------------------
// Rung 1 — structural (proven), diffed against the baseline

function verifyApiUnchanged(
  lock: VibeCheck,
  baseline: Baseline | null,
  baselineRel: string | undefined,
  indexAfter: RepoIndex,
  domains: DomainRegistry,
): VerificationItem[] {
  const items: VerificationItem[] = [];
  const graphAfter = buildGraph(indexAfter, domains);
  for (const clause of lock.keep) {
    if (clause.kind !== "api-unchanged") continue;
    for (const id of clause.symbols ?? []) {
      const subject = `api-unchanged · ${id}`;
      if (!baseline) {
        items.push(uncheckedItem("keep-clause", subject, "no pre-change baseline (run `cdir run` to capture one)", clause.kind));
        continue;
      }
      const before = baseline.signatures[id];
      if (before === undefined) {
        items.push(uncheckedItem("keep-clause", subject, "symbol not captured in baseline (did not resolve pre-change)", clause.kind));
        continue;
      }
      const artifactRef = `${baselineRel}#signatures[${id}]`;
      const sym = graphAfter.symbols.get(id);
      if (!sym) {
        items.push({ source: "keep-clause", clauseKind: clause.kind, subject, verdict: "violated", evidenceClass: "proven", detail: `${id} no longer exists`, artifactRef });
      } else if (signatureHash(sym.signature) !== before) {
        items.push({ source: "keep-clause", clauseKind: clause.kind, subject, verdict: "violated", evidenceClass: "proven", detail: `signature changed: ${id}`, artifactRef });
      } else {
        items.push({ source: "keep-clause", clauseKind: clause.kind, subject, verdict: "held", evidenceClass: "proven", detail: `signature unchanged: ${id}`, artifactRef });
      }
    }
  }
  return items;
}

function verifyNoNewDependency(
  rootDir: string,
  lock: VibeCheck,
  baseline: Baseline | null,
  baselineRel: string | undefined,
  domains: DomainRegistry,
): VerificationItem[] {
  const items: VerificationItem[] = [];
  if (!lock.keep.some((c) => c.kind === "no-new-dependency")) return items;
  const kind = "no-new-dependency" as const;
  if (!baseline) {
    items.push(uncheckedItem("keep-clause", `no-new-dependency`, "no pre-change baseline (run `cdir run` to capture one)", kind));
    return items;
  }
  const artifactFor = (m: string) => `${baselineRel}#manifests[${m}]`;
  for (const [m, before] of Object.entries(baseline.manifests)) {
    const subject = `no-new-dependency · ${m}`;
    const p = path.join(rootDir, m);
    if (!fs.existsSync(p)) {
      items.push({ source: "keep-clause", clauseKind: kind, subject, verdict: "violated", evidenceClass: "proven", detail: `${m} deleted`, artifactRef: artifactFor(m) });
      continue;
    }
    const after = domains.manifestFingerprint(m, fs.readFileSync(p, "utf8"));
    items.push(
      after === before
        ? { source: "keep-clause", clauseKind: kind, subject, verdict: "held", evidenceClass: "proven", detail: `${m} unchanged`, artifactRef: artifactFor(m) }
        : { source: "keep-clause", clauseKind: kind, subject, verdict: "violated", evidenceClass: "proven", detail: `${m} changed`, artifactRef: artifactFor(m) },
    );
  }
  // a manifest that did not exist before but exists now is a new dependency surface
  for (const m of appearedManifests(rootDir, baseline, domains)) {
    items.push({ source: "keep-clause", clauseKind: kind, subject: `no-new-dependency · ${m}`, verdict: "violated", evidenceClass: "proven", detail: `${m} appeared`, artifactRef: artifactFor(m) });
  }
  if (items.length === 0) {
    items.push({
      source: "keep-clause",
      clauseKind: kind,
      subject: "no-new-dependency",
      verdict: "held",
      evidenceClass: "proven",
      detail: "no dependency manifests present before or after — clause holds vacuously",
      artifactRef: `${baselineRel}#manifests`,
    });
  }
  return items;
}

// ---------------------------------------------------------------------
// Rung 1b — refresh (measured): commands that bring generated outputs up to
// date before typecheck, the tests or the verifyCommand read them

interface StatusEntry {
  status: string;
  /** sha256 of the path's bytes at snapshot time; null when it is not a readable file. */
  hash: string | null;
}

/** sha256 of a git-reported path, or null when it is not a readable file. */
function hashGitPath(rootDir: string, gitPath: string): string | null {
  try {
    return sha256Bytes(fs.readFileSync(path.join(rootDir, gitToAbsRel(rootDir, gitPath))));
  } catch {
    return null;
  }
}

/**
 * `git status --porcelain=v1 -z --untracked-files=all`, keyed by path, with
 * the bytes' sha256: a file that was already dirty keeps the same status
 * line when the refresh rewrites it, and only the hash says so. Ignored
 * files are absent by construction — those are the ones a refresh may change.
 */
function statusSnapshot(rootDir: string): Map<string, StatusEntry> {
  const out = new Map<string, StatusEntry>();
  let raw: string;
  try {
    raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return out; // not a git work tree (or no git): nothing to compare
  }
  const entries = raw.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const p = entry.slice(3);
    out.set(p, { status, hash: hashGitPath(rootDir, p) });
    if (status.startsWith("R") || status.startsWith("C")) {
      // In -z form a rename/copy carries its other path as the next token.
      const other = entries[++i];
      if (other !== undefined && other !== "") out.set(other, { status, hash: hashGitPath(rootDir, other) });
    }
  }
  return out;
}

/** Paths whose status line appeared, vanished or changed, or whose bytes did. */
function refreshWrites(before: Map<string, StatusEntry>, after: Map<string, StatusEntry>): string[] {
  const written: string[] = [];
  for (const p of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(p);
    const now = after.get(p);
    if (was === undefined || now === undefined || was.status !== now.status || was.hash !== now.hash) written.push(p);
  }
  return written;
}

/**
 * The rules file's `refresh:` commands: the generation step that makes the
 * after-checks read today's output instead of a build from hours ago. They
 * run after the structural rung and before typecheck, tests-pass, the
 * verifyCommand and output-unchanged; they take no shared turn (a build is
 * meant to be fast, and a turn would make it wait behind the checks it
 * exists to feed). A failing command stops the remaining ones — every later
 * rung still runs — and the skipped commands are named. A refresh may only
 * change ignored files: git status is compared before the first command and
 * after the last, and any other path is a violation.
 */
function verifyRefresh(rootDir: string, lock: VibeCheck, opts: VerifyOptions): VerificationItem[] {
  const file = loadChecks(rootDir);
  const commands = file.status === "rules" ? file.rules.refresh : undefined;
  if (!commands || commands.length === 0) return [];
  const timeout = resolveVerifyTimeoutMs(lock, opts);
  phaseFor(rootDir, "refresh");
  const before = statusSnapshot(rootDir);
  const items: VerificationItem[] = [];
  let failed = false;
  for (const command of commands) {
    const subject = `refresh · ${command}`;
    if (failed) {
      items.push(uncheckedItem("refresh", subject, "skipped: an earlier refresh failed"));
      continue;
    }
    // No takeTurn: a refresh is a fast generation step, and a turn would make
    // it wait behind the very checks that read its output.
    const probe = runShellProbe(rootDir, command, timeout, opts.env);
    const artifactRef = probeArtifactRef(`sh -c ${JSON.stringify(command)}`, probe);
    if (probe.timedOut) {
      items.push(uncheckedItem("refresh", subject, `refresh timed out after ${timeout}ms`));
      failed = true;
      continue;
    }
    if (probe.error || probe.exitCode === null) {
      items.push(uncheckedItem("refresh", subject, `refresh could not run: ${probe.error ?? "spawn failed"}`));
      failed = true;
      continue;
    }
    if (probe.exitCode === 0) {
      items.push({ source: "refresh", subject, verdict: "held", evidenceClass: "measured", detail: `refresh passed: ${command}`, artifactRef });
      continue;
    }
    const excerpt = probeExcerpt(probe);
    items.push({
      source: "refresh",
      subject,
      verdict: "violated",
      evidenceClass: "measured",
      detail: `refresh failed (exit ${probe.exitCode}): ${command}${excerpt ? ` — output: ${excerpt}` : ""}`,
      artifactRef,
    });
    failed = true;
  }
  const written = refreshWrites(before, statusSnapshot(rootDir));
  if (written.length > 0) {
    const shown = written.slice(0, 5).join(", ") + (written.length > 5 ? ` and ${written.length - 5} more` : "");
    items.push({
      source: "refresh",
      subject: "refresh · written files",
      verdict: "violated",
      evidenceClass: "measured",
      detail: `refresh changed ${shown}, which is not an ignored output — a refresh may only bring ignored outputs up to date`,
    });
  }
  return items;
}

// ---------------------------------------------------------------------
// Rung 2 — typecheck (proven when clean)

/** A check's pre-run diagnostics, or undefined when the baseline has no record of them. */
function baselineDiagnostics(baseline: Baseline | null, check: DiagnosticsCheck): string[] | undefined {
  if (!baseline) return undefined;
  if (baseline.diagnostics) return baseline.diagnostics[check.id];
  if (check.legacyBaselineField) {
    const legacy = (baseline as unknown as Record<string, unknown>)[check.legacyBaselineField];
    if (Array.isArray(legacy)) return legacy as string[];
  }
  return undefined;
}

/**
 * Each domain's compiler check, judged against the diagnostics the baseline
 * recorded before the run: only diagnostics the run added are its
 * violation. A baseline without that record (captured before it existed,
 * tampered, or taken when the compiler could not run) keeps the old strict
 * reading — any error fails.
 */
function verifyDiagnostics(
  rootDir: string,
  opts: VerifyOptions,
  baseline: Baseline | null,
  domains: DomainRegistry,
): VerificationItem[] {
  if (opts.typecheck === false) return [];
  return domains.diagnosticsChecks().map((check) => verifyOneDiagnosticsCheck(rootDir, opts, baseline, check));
}

function verifyOneDiagnosticsCheck(
  rootDir: string,
  opts: VerifyOptions,
  baseline: Baseline | null,
  check: DiagnosticsCheck,
): VerificationItem {
  const subject = check.subject;
  const result = probeDiagnostics(rootDir, check, {
    timeoutMs: opts.typecheckTimeoutMs,
    env: opts.env,
    onPutBack: (p) => opts.putBack?.push({ probe: subject, ...p }),
  });
  if (result.kind === "not-applicable" || result.kind === "unavailable") {
    return uncheckedItem("typecheck", subject, result.reason);
  }
  const { probe, how } = result;
  const artifactRef = `${how} → exit ${probe.exitCode}`;
  if (probe.exitCode === 0) {
    return { source: "typecheck", subject, verdict: "held", evidenceClass: "proven", detail: `${check.label} clean`, artifactRef };
  }
  const before = baselineDiagnostics(baseline, check);
  const after = check.parse(probe.stdout, probe.stderr);
  if (before !== undefined && after.length > 0) {
    const fresh = newDiagnostics(before, after);
    if (fresh.length === 0) {
      return {
        source: "typecheck",
        subject,
        verdict: "held",
        evidenceClass: "measured",
        detail: `${check.label}: ${after.length} error(s), all present before the run — none new`,
        artifactRef,
      };
    }
    return {
      source: "typecheck",
      subject,
      verdict: "violated",
      evidenceClass: "measured",
      detail: `${check.label}: ${fresh.length} new error(s) since the baseline: ${fresh.slice(0, 5).map((e) => e.line).join(" · ")}`,
      artifactRef,
    };
  }
  return {
    source: "typecheck",
    subject,
    verdict: "violated",
    evidenceClass: "measured",
    detail: `${check.label} failed (exit ${probe.exitCode})${diagnosticsExcerpt(check, probe.stdout, probe.stderr)}`,
    artifactRef,
  };
}

// ---------------------------------------------------------------------
// Rung 3 — tests (measured): tests-pass globs + Lock-level verifyCommand

/**
 * The timeout for tests-pass runs and verifyCommand. A lock that promises a
 * verifyCommand but names no timeout gets the floor — never a silent 60s that
 * no real chain fits.
 */
export function resolveVerifyTimeoutMs(lock: VibeCheck, opts: VerifyOptions): number {
  if (opts.testTimeoutMs !== undefined) return opts.testTimeoutMs;
  if (lock.verifyTimeoutMs !== undefined) return lock.verifyTimeoutMs;
  return lock.verifyCommand ? DEFAULT_VERIFY_TIMEOUT_MS : 60_000;
}

function verifyTestsPass(rootDir: string, lock: VibeCheck, opts: VerifyOptions, domains: DomainRegistry): VerificationItem[] {
  const items: VerificationItem[] = [];
  const timeout = resolveVerifyTimeoutMs(lock, opts);
  const found = domains.testRunner();
  // Expanding the glob skips what the core never reads plus what the
  // runner's own domain says is never source (node_modules for node).
  const skipDirs = new Set([...CORE_SKIP_DIRS, ...(found?.domain.generatedPathRules?.neverSourceDirs ?? [])]);
  for (const clause of lock.keep) {
    if (clause.kind !== "tests-pass") continue;
    const glob = clause.glob ?? "";
    const subject = `tests-pass · ${glob}`;
    phaseFor(rootDir, `tests-pass ${glob}`);
    if (!found) {
      items.push(uncheckedItem("keep-clause", subject, "no test runner is registered for tests-pass", clause.kind));
      continue;
    }
    const { runner } = found;
    const files = expandGlob(rootDir, glob, skipDirs);
    if (files.length === 0) {
      items.push({
        source: "keep-clause",
        clauseKind: clause.kind,
        subject,
        verdict: "violated",
        // Nothing executed — the empty expansion is a structural fact, not a measurement.
        evidenceClass: "proven",
        detail: `glob matched no test files: ${glob}`,
        artifactRef: `glob expansion → 0 file(s) matched ${JSON.stringify(glob)}`,
      });
      continue;
    }
    const foreign = files.filter((f) => !runner.acceptsFile(f));
    if (foreign.length > 0) {
      // Nothing is run: the runner would fail on these files whatever the tests say.
      items.push(
        uncheckedItem(
          "keep-clause",
          subject,
          `${runner.label} cannot run ${foreign.length} matched file(s) (${foreign.slice(0, 3).join(", ")}) — ` +
            `tests-pass measures ${runner.covers} suites only; put this suite in the lock's verifyCommand`,
          clause.kind,
        ),
      );
      continue;
    }
    const argv = runner.argv(files);
    const probe = runIsolated(rootDir, () => runArgvProbe(rootDir, argv, timeout, opts.env), (p) => opts.putBack?.push({ probe: subject, ...p }));
    const artifactRef = `${runner.label} ${glob} (${files.length} file(s)) → exit ${probe.exitCode ?? "?"}`;
    if (probe.timedOut) {
      items.push(uncheckedItem("keep-clause", subject, `test run timed out after ${timeout}ms`, clause.kind));
    } else if (probe.error || probe.exitCode === null) {
      items.push(uncheckedItem("keep-clause", subject, `test runner could not run: ${probe.error ?? "spawn failed"}`, clause.kind));
    } else if (probe.exitCode === 0) {
      items.push({ source: "keep-clause", clauseKind: clause.kind, subject, verdict: "held", evidenceClass: "measured", detail: `${files.length} test file(s) pass under ${runner.label}`, artifactRef });
    } else {
      const names = runner.failures(`${probe.stdout}\n${probe.stderr}`);
      items.push({
        source: "keep-clause",
        clauseKind: clause.kind,
        subject,
        verdict: "violated",
        evidenceClass: "measured",
        detail: `tests failing (exit ${probe.exitCode})${names.length > 0 ? `: ${names.join(" · ")}` : ""}`,
        artifactRef,
      });
    }
  }
  return items;
}

/**
 * What a failed verifyCommand says: the tests it named first — read from the
 * whole output, not the kept tail — then the tail excerpt as the command's
 * own last words. With no recognisable test name it is the old detail, word
 * for word.
 */
function failedVerifyCommandDetail(command: string, exitCode: number, probe: ProbeResult): { detail: string; failedTests?: string[] } {
  const failed = readFailedTests(`${probe.stdout}\n${probe.stderr}`);
  const names = formatFailedTests(failed);
  const excerpt = probeExcerpt(probe);
  const head = `verifyCommand failed (exit ${exitCode}): ${command}`;
  const tail = excerpt ? ` — output: ${excerpt}` : "";
  if (names.length === 0) return { detail: `${head}${tail}` };
  const total = failed.tests.length + failed.omitted;
  return {
    detail: `${head} — ${total} failed test${total === 1 ? "" : "s"}: ${names}${tail}`,
    failedTests: failedTestLabels(failed),
  };
}

function verifyCommand(rootDir: string, lock: VibeCheck, opts: VerifyOptions): VerificationItem[] {
  if (!lock.verifyCommand) return [];
  const subject = `verifyCommand · ${lock.verifyCommand}`;
  const timeout = resolveVerifyTimeoutMs(lock, opts);
  phaseFor(rootDir, "verifyCommand");
  // When the repo's rules ask for turns, wait for ours first: the wait is not
  // part of the timeout, which starts when the command does.
  const taken = takeTurn(rootDir, lock.verifyCommand, opts.env);
  if ("refused" in taken) return [uncheckedItem("verify-command", subject, taken.refused)];
  phaseFor(rootDir, "verifyCommand"); // the turn, if any, was only a wait
  const { turn } = taken;
  let probe: ProbeResult;
  try {
    probe = runIsolated(
      rootDir,
      () => runShellProbe(rootDir, lock.verifyCommand!, timeout, opts.env),
      (p) => opts.putBack?.push({ probe: subject, ...p }),
    );
  } finally {
    turn.release();
  }
  const artifactRef = `sh -c ${JSON.stringify(lock.verifyCommand)} → exit ${probe.exitCode ?? "?"}`;
  if (probe.timedOut) {
    return [uncheckedItem("verify-command", subject, `verifyCommand timed out after ${timeout}ms`)];
  }
  if (probe.error || probe.exitCode === null) {
    return [uncheckedItem("verify-command", subject, `verifyCommand could not run: ${probe.error ?? "spawn failed"}`)];
  }
  if (probe.exitCode === 0) {
    return [{ source: "verify-command", subject, verdict: "held", evidenceClass: "measured", detail: `verifyCommand passed: ${lock.verifyCommand}${turn.waitNote}`, artifactRef }];
  }
  // A failure has to be diagnosable from the report alone: the tests that
  // failed, the command's own last words, and the hashes of everything it
  // said. A pass needs none of it — its exit code is the whole story.
  const { detail, failedTests } = failedVerifyCommandDetail(lock.verifyCommand, probe.exitCode, probe);
  const item: VerificationItem = {
    source: "verify-command",
    subject,
    verdict: "violated",
    evidenceClass: "measured",
    detail: `${detail}${turn.waitNote}`,
    artifactRef: probeArtifactRef(`sh -c ${JSON.stringify(lock.verifyCommand)}`, probe),
    ...(failedTests !== undefined ? { failedTests } : {}),
  };
  return [item];
}

// ---------------------------------------------------------------------
// Rung 4 — output-unchanged (measured, differential vs baseline)

function verifyOutputUnchanged(rootDir: string, lock: VibeCheck, baseline: Baseline | null, baselineRel: string | undefined, opts: VerifyOptions): VerificationItem[] {
  const items: VerificationItem[] = [];
  const timeout = opts.outputTimeoutMs ?? 30_000;
  for (const clause of lock.keep) {
    if (clause.kind !== "output-unchanged" || !clause.command) continue;
    const cmd = clause.command;
    const subject = `output-unchanged · ${cmd}`;
    phaseFor(rootDir, `output-unchanged ${cmd}`);
    const captured = baseline?.outputs?.[cmd];
    if (!baseline || !captured) {
      items.push(uncheckedItem("keep-clause", subject, "no pre-change baseline for this command (lock edited after the baseline was captured)", clause.kind));
      continue;
    }
    if (captured.stdoutSha256 === undefined) {
      items.push(uncheckedItem("keep-clause", subject, `baseline capture failed (${captured.error ?? "unknown"}) — nothing to diff against`, clause.kind));
      continue;
    }
    const probe = runIsolated(rootDir, () => runShellProbe(rootDir, cmd, timeout, opts.env), (p) => opts.putBack?.push({ probe: subject, ...p }));
    const baseRef = `${baselineRel}#outputs[${JSON.stringify(cmd)}]`;
    if (probe.timedOut || probe.error || probe.exitCode === null) {
      items.push(uncheckedItem("keep-clause", subject, `command could not run at verify time: ${probe.timedOut ? `timed out after ${timeout}ms` : probe.error}`, clause.kind));
      continue;
    }
    const artifactRef = `sh -c ${JSON.stringify(cmd)} → exit ${probe.exitCode} · stdout sha256 ${probe.stdoutSha256.slice(0, 12)}… · baseline ${baseRef}`;
    if (probe.exitCode !== 0) {
      items.push({ source: "keep-clause", clauseKind: clause.kind, subject, verdict: "violated", evidenceClass: "measured", detail: `output command exited ${probe.exitCode} after the change (was 0 at baseline)`, artifactRef });
      continue;
    }
    // Hashes of the whole output: the text a probe returns is capped.
    const afterOut = probe.stdoutSha256;
    const afterErr = probe.stderrSha256;
    const stdoutOk = afterOut === captured.stdoutSha256;
    const stderrOk = captured.stderrSha256 === undefined || afterErr === captured.stderrSha256;
    items.push(
      stdoutOk && stderrOk
        ? { source: "keep-clause", clauseKind: clause.kind, subject, verdict: "held", evidenceClass: "measured", detail: `output byte-identical (sha256 ${afterOut.slice(0, 12)}…)`, artifactRef }
        : {
            source: "keep-clause",
            clauseKind: clause.kind,
            subject,
            verdict: "violated",
            evidenceClass: "measured",
            detail: stdoutOk
              ? `stderr changed: sha256 ${captured.stderrSha256?.slice(0, 12)}… → ${afterErr.slice(0, 12)}…`
              : `output changed: sha256 ${captured.stdoutSha256.slice(0, 12)}… → ${afterOut.slice(0, 12)}…`,
            artifactRef,
          },
    );
  }
  return items;
}

// ---------------------------------------------------------------------
// Rung 5 — custom (always unchecked; the human judges)

function verifyCustom(lock: VibeCheck): VerificationItem[] {
  const items: VerificationItem[] = [];
  for (const clause of lock.keep) {
    if (clause.kind !== "custom") continue;
    const text = clause.text ?? "(empty)";
    items.push(uncheckedItem("keep-clause", `custom · ${text}`, "not machine-checkable — human judges", clause.kind));
  }
  return items;
}

// ---------------------------------------------------------------------

/**
 * Run the ladder against an explicit (or null) baseline and an already-built
 * post-change index. Synchronous: all probes are spawnSync with timeouts.
 */
export function verifyWithBaseline(
  rootDir: string,
  lock: VibeCheck,
  baseline: Baseline | null,
  baselineRel: string | undefined,
  indexAfter: RepoIndex,
  given: VerifyOptions = {},
): VerificationReport {
  const putBack = given.putBack ?? [];
  const opts: VerifyOptions = { ...given, putBack };
  const domains = given.domains ?? defaultDomains();
  const tampered = baselineTampered(rootDir, baselineRel, opts);
  // Each rung says where the work is, so a reader in another process sees it.
  phaseFor(rootDir, "structural checks");
  const structural = [
    ...verifyApiUnchanged(lock, baseline, baselineRel, indexAfter, domains),
    ...verifyNoNewDependency(rootDir, lock, baseline, baselineRel, domains),
  ];
  const refresh = verifyRefresh(rootDir, lock, opts);
  phaseFor(rootDir, "typecheck");
  const typecheck = verifyDiagnostics(rootDir, opts, tampered ? null : baseline, domains);
  phaseFor(rootDir, "tests-pass");
  const tests = verifyTestsPass(rootDir, lock, opts, domains);
  phaseFor(rootDir, "verifyCommand");
  const commandChecks = verifyCommand(rootDir, lock, opts);
  phaseFor(rootDir, "output-unchanged");
  const outputs = verifyOutputUnchanged(rootDir, lock, baseline, baselineRel, opts);
  let items: VerificationItem[] = [...structural, ...refresh, ...typecheck, ...tests, ...commandChecks, ...outputs, ...verifyCustom(lock)];
  if (tampered) {
    // A tampered baseline invalidates every differential check against it.
    // Tests/typecheck/verifyCommand are self-contained and still count.
    items = items.map((i) =>
      i.source === "keep-clause" && BASELINE_DEPENDENT_KINDS.has(i.clauseKind ?? "")
        ? uncheckedItem(i.source, i.subject, TAMPER_REASON, i.clauseKind)
        : i,
    );
  }
  const violations = items
    .filter((i) => i.verdict === "violated")
    .map((i) => (i.source === "keep-clause" ? `KEEP ${i.clauseKind}: ${i.detail}` : `VERIFY ${i.source}: ${i.detail}`));
  if (tampered) violations.unshift(`BASELINE TAMPERED: ${baselineRel} — ${TAMPER_REASON}`);
  return {
    lockId: lock.id,
    verifiedAt: new Date().toISOString(),
    ...(baselineRel !== undefined ? { baselinePath: baselineRel } : {}),
    ...(tampered ? { baselineTampered: true } : {}),
    items,
    ...(putBack.length > 0 ? { putBack } : {}),
    violations,
    counts: countByClass(items),
  };
}

/**
 * `cdir verify <lock-id>`: re-index, load the lock's TASK baseline (or the
 * one passed explicitly), and run the ladder. Without a task baseline,
 * structural and output checks report Unchecked — "no pre-change baseline" —
 * while tests and typecheck still run (they are self-contained); the report
 * that consumes this result says incomplete, never verified.
 */
/** A standalone verify's claim on the root, or the refusal a second process deserves. */
function openVerifyClaim(rootDir: string, lock: VibeCheck): ClaimHandle {
  try {
    return claimRoot(rootDir, {
      kind: "verify",
      lockId: lock.id,
      command: lock.verifyCommand ?? "verify",
      phase: "loading the baseline",
    });
  } catch (e) {
    if (e instanceof ClaimError) throw new VerifyError(e.message);
    throw e;
  }
}

export async function verifyLock(rootDir: string, lockId: string, opts: VerifyOptions = {}): Promise<VerificationReport> {
  const lock = loadLock(rootDir, lockId);
  if (!lock) throw new VerifyError(`no such lock: ${lockId} (see \`cdir lock ls\`)`);
  // Sealed contract: verifying against a Lock edited after approval would
  // grade the agent's own amendment — refuse until the user re-approves.
  const seal = sealViolation(rootDir, lock);
  if (seal) throw new VerifyError(seal);
  // A standalone verify works the tree, so it holds the root's claim like a
  // run does; nested inside a run or a re-verifying report that already
  // claimed, it shares that claim — never two.
  const claim = openVerifyClaim(rootDir, lock);
  try {
    return await verifyClaimed(rootDir, lock, opts);
  } finally {
    claim.release();
  }
}

/** The body of a claimed standalone verify. */
async function verifyClaimed(rootDir: string, lock: VibeCheck, opts: VerifyOptions): Promise<VerificationReport> {
  const lockId = lock.id;
  const taskBaselineFile = taskBaselinePath(rootDir, lockId);
  const baselinePath = opts.baselinePath ?? (fs.existsSync(taskBaselineFile) ? taskBaselineFile : undefined);
  let baseline: Baseline | null = null;
  if (baselinePath) {
    try {
      baseline = loadBaseline(baselinePath);
    } catch {
      // Corrupted/unreadable baseline (e.g. tampered mid-run): checks report
      // Unchecked; when a capture-time hash is known the tamper reason applies.
      baseline = null;
    }
  }
  const baselineRel = baselinePath ? path.relative(rootDir, baselinePath).split(path.sep).join("/") : undefined;
  const { index } = await buildIndex(rootDir, { domains: opts.domains });
  return verifyWithBaseline(rootDir, lock, baseline, baselineRel, index, opts);
}
