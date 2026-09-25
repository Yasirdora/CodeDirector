/**
 * The verification ladder (blueprint §17), applied after a change:
 *
 *   1. Structural (proven)   — api-unchanged signature hashes and
 *                              no-new-dependency manifest hashes diffed
 *                              against the pre-captured baseline.
 *   2. Typecheck (proven)    — `tsc --noEmit` when a tsconfig exists and a
 *                              compiler is available; otherwise Unchecked
 *                              with the reason named. Only errors absent
 *                              from the baseline are the run's.
 *   3. Tests (measured)      — each tests-pass glob run via `node --test`;
 *                              a Lock-level verifyCommand ("npm test", ...)
 *                              executed the same way.
 *   4. Output (measured)     — output-unchanged commands re-run; stdout
 *                              sha256 compared to the baseline capture.
 *   5. Custom (unchecked)    — always "human judges". This honesty is the
 *                              feature, per the blueprint.
 *
 * Read-only by construction: this module writes nothing to the repository
 * (the index refresh writes only .codedirector/, our own metadata area).
 * The commands being probed run with normal repo permissions — a fully
 * sandboxed verifier is a later phase.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RepoIndex } from "../core/types";
import { buildIndex, hashContent } from "../core/builder";
import { buildGraph } from "../core/graph";
import { VibeCheck, DEPENDENCY_MANIFESTS, NODE_TEST_FILE } from "../lock/types";
import { loadLock } from "../lock/store";
import { sealViolation } from "../lock/seal";
import { signatureHash } from "../lock/check";
import { matchPath } from "../lock/glob";
import { Baseline, baselineFileHash, latestBaselinePath, loadBaseline } from "../run/baseline";
import { dependencyFingerprint } from "../run/deps";
import { runArgvProbe, runShellProbe, sha256 } from "../run/probe";
import { runIsolated } from "../run/tree";
import { newTypecheckErrors, probeTypecheck, typecheckErrors } from "../run/typecheck";
import {
  countByClass,
  ProbePutBack,
  VerificationItem,
  VerificationReport,
} from "./types";

export class VerifyError extends Error {}

export interface VerifyOptions {
  /** Explicit baseline path; default is the latest baseline for the lock. */
  baselinePath?: string;
  /** Run the typecheck rung (default true). */
  typecheck?: boolean;
  /** tsc --noEmit timeout (default 120s). */
  typecheckTimeoutMs?: number;
  /** Per-test-run and verifyCommand timeout (default: lock.verifyTimeoutMs, else 60s). */
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
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".codedirector"]);

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

/** Repo-relative files matching a glob, deterministic order. */
function expandGlob(rootDir: string, glob: string): string[] {
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
        if (SKIP_DIRS.has(e.name) || e.isDirectory()) continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
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
): VerificationItem[] {
  const items: VerificationItem[] = [];
  const graphAfter = buildGraph(indexAfter);
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
    const raw = fs.readFileSync(p, "utf8");
    const after = m === "package.json" ? dependencyFingerprint(raw) : hashContent(raw);
    items.push(
      after === before
        ? { source: "keep-clause", clauseKind: kind, subject, verdict: "held", evidenceClass: "proven", detail: `${m} unchanged`, artifactRef: artifactFor(m) }
        : { source: "keep-clause", clauseKind: kind, subject, verdict: "violated", evidenceClass: "proven", detail: `${m} changed`, artifactRef: artifactFor(m) },
    );
  }
  // a manifest that did not exist before but exists now is a new dependency surface
  for (const m of DEPENDENCY_MANIFESTS) {
    if (!(m in baseline.manifests) && fs.existsSync(path.join(rootDir, m))) {
      items.push({ source: "keep-clause", clauseKind: kind, subject: `no-new-dependency · ${m}`, verdict: "violated", evidenceClass: "proven", detail: `${m} appeared`, artifactRef: artifactFor(m) });
    }
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
// Rung 2 — typecheck (proven when clean)

/** First diagnostic lines from compiler output (error lines preferred). */
function compilerDiagnostics(stdout: string, stderr: string): string {
  const errorLines = stdout.split("\n").filter((l) => l.includes("error TS")).slice(0, 5);
  if (errorLines.length > 0) return `: ${errorLines.join(" · ")}`;
  const any = `${stdout}\n${stderr}`.split("\n").filter((l) => l.trim()).slice(0, 3);
  return any.length > 0 ? ` — output: ${any.join(" · ").slice(0, 300)}` : "";
}

/**
 * `tsc --noEmit`, judged against the errors the baseline recorded before the
 * run: only errors the run added are its violation. A baseline without that
 * record (captured before it existed, tampered, or taken when the compiler
 * could not run) keeps the old strict reading — any error fails.
 */
function verifyTypecheck(rootDir: string, opts: VerifyOptions, baseline: Baseline | null): VerificationItem[] {
  if (opts.typecheck === false) return [];
  const subject = "typecheck · tsc --noEmit";
  const result = probeTypecheck(rootDir, {
    timeoutMs: opts.typecheckTimeoutMs,
    env: opts.env,
    onPutBack: (p) => opts.putBack?.push({ probe: subject, ...p }),
  });
  if (result.kind === "no-tsconfig") {
    return [uncheckedItem("typecheck", subject, "no tsconfig.json — typecheck rung skipped")];
  }
  if (result.kind === "unavailable") return [uncheckedItem("typecheck", subject, result.reason)];
  const { probe, how } = result;
  const artifactRef = `${how} → exit ${probe.exitCode}`;
  if (probe.exitCode === 0) {
    return [{ source: "typecheck", subject, verdict: "held", evidenceClass: "proven", detail: "tsc --noEmit clean", artifactRef }];
  }
  const before = baseline?.typecheckErrors;
  const after = typecheckErrors(probe.stdout);
  if (before !== undefined && after.length > 0) {
    const fresh = newTypecheckErrors(before, after);
    if (fresh.length === 0) {
      return [{
        source: "typecheck",
        subject,
        verdict: "held",
        evidenceClass: "measured",
        detail: `tsc --noEmit: ${after.length} error(s), all present before the run — none new`,
        artifactRef,
      }];
    }
    return [{
      source: "typecheck",
      subject,
      verdict: "violated",
      evidenceClass: "measured",
      detail: `tsc --noEmit: ${fresh.length} new error(s) since the baseline: ${fresh.slice(0, 5).map((e) => e.line).join(" · ")}`,
      artifactRef,
    }];
  }
  return [{
    source: "typecheck",
    subject,
    verdict: "violated",
    evidenceClass: "measured",
    detail: `tsc --noEmit failed (exit ${probe.exitCode})${compilerDiagnostics(probe.stdout, probe.stderr)}`,
    artifactRef,
  }];
}

// ---------------------------------------------------------------------
// Rung 3 — tests (measured): tests-pass globs + Lock-level verifyCommand

function failingTestNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*not ok \d+ - (.+)$/.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1].trim());
    if (names.length >= 5) break;
  }
  return names;
}

function verifyTestsPass(rootDir: string, lock: VibeCheck, opts: VerifyOptions): VerificationItem[] {
  const items: VerificationItem[] = [];
  const timeout = opts.testTimeoutMs ?? lock.verifyTimeoutMs ?? 60_000;
  for (const clause of lock.keep) {
    if (clause.kind !== "tests-pass") continue;
    const glob = clause.glob ?? "";
    const subject = `tests-pass · ${glob}`;
    const files = expandGlob(rootDir, glob);
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
    const foreign = files.filter((f) => !NODE_TEST_FILE.test(f));
    if (foreign.length > 0) {
      // Nothing is run: node would fail on these files whatever the tests say.
      items.push(
        uncheckedItem(
          "keep-clause",
          subject,
          `node --test cannot run ${foreign.length} matched file(s) (${foreign.slice(0, 3).join(", ")}) — ` +
            `tests-pass measures JavaScript/TypeScript suites only; put this suite in the lock's verifyCommand`,
          clause.kind,
        ),
      );
      continue;
    }
    const argv = [process.execPath];
    const major = parseInt(process.versions.node, 10);
    if (major >= 22 && files.some((f) => /\.[cm]?tsx?$/.test(f))) {
      argv.push("--experimental-strip-types");
    }
    argv.push("--test", "--test-reporter=tap", ...files);
    const probe = runIsolated(rootDir, () => runArgvProbe(rootDir, argv, timeout, opts.env), (p) => opts.putBack?.push({ probe: subject, ...p }));
    const artifactRef = `node --test ${glob} (${files.length} file(s)) → exit ${probe.exitCode ?? "?"}`;
    if (probe.timedOut) {
      items.push(uncheckedItem("keep-clause", subject, `test run timed out after ${timeout}ms`, clause.kind));
    } else if (probe.error || probe.exitCode === null) {
      items.push(uncheckedItem("keep-clause", subject, `test runner could not run: ${probe.error ?? "spawn failed"}`, clause.kind));
    } else if (probe.exitCode === 0) {
      items.push({ source: "keep-clause", clauseKind: clause.kind, subject, verdict: "held", evidenceClass: "measured", detail: `${files.length} test file(s) pass under node --test`, artifactRef });
    } else {
      const names = failingTestNames(`${probe.stdout}\n${probe.stderr}`);
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

function verifyCommand(rootDir: string, lock: VibeCheck, opts: VerifyOptions): VerificationItem[] {
  if (!lock.verifyCommand) return [];
  const subject = `verifyCommand · ${lock.verifyCommand}`;
  const timeout = opts.testTimeoutMs ?? lock.verifyTimeoutMs ?? 60_000;
  const probe = runIsolated(
    rootDir,
    () => runShellProbe(rootDir, lock.verifyCommand!, timeout, opts.env),
    (p) => opts.putBack?.push({ probe: subject, ...p }),
  );
  const artifactRef = `sh -c ${JSON.stringify(lock.verifyCommand)} → exit ${probe.exitCode ?? "?"}`;
  if (probe.timedOut) {
    return [uncheckedItem("verify-command", subject, `verifyCommand timed out after ${timeout}ms`)];
  }
  if (probe.error || probe.exitCode === null) {
    return [uncheckedItem("verify-command", subject, `verifyCommand could not run: ${probe.error ?? "spawn failed"}`)];
  }
  if (probe.exitCode === 0) {
    return [{ source: "verify-command", subject, verdict: "held", evidenceClass: "measured", detail: `verifyCommand passed: ${lock.verifyCommand}`, artifactRef }];
  }
  return [{ source: "verify-command", subject, verdict: "violated", evidenceClass: "measured", detail: `verifyCommand failed (exit ${probe.exitCode}): ${lock.verifyCommand}`, artifactRef }];
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
    const artifactRef = `sh -c ${JSON.stringify(cmd)} → exit ${probe.exitCode} · stdout sha256 ${sha256(probe.stdout).slice(0, 12)}… · baseline ${baseRef}`;
    if (probe.exitCode !== 0) {
      items.push({ source: "keep-clause", clauseKind: clause.kind, subject, verdict: "violated", evidenceClass: "measured", detail: `output command exited ${probe.exitCode} after the change (was 0 at baseline)`, artifactRef });
      continue;
    }
    const afterOut = sha256(probe.stdout);
    const afterErr = sha256(probe.stderr);
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
  const tampered = baselineTampered(rootDir, baselineRel, opts);
  let items: VerificationItem[] = [
    ...verifyApiUnchanged(lock, baseline, baselineRel, indexAfter),
    ...verifyNoNewDependency(rootDir, lock, baseline, baselineRel),
    ...verifyTypecheck(rootDir, opts, tampered ? null : baseline),
    ...verifyTestsPass(rootDir, lock, opts),
    ...verifyCommand(rootDir, lock, opts),
    ...verifyOutputUnchanged(rootDir, lock, baseline, baselineRel, opts),
    ...verifyCustom(lock),
  ];
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
 * `cdir verify <lock-id>`: re-index, load the latest baseline for the lock
 * (or the one passed explicitly), and run the ladder. Without any baseline,
 * structural and output checks report Unchecked — "no pre-change baseline" —
 * while tests and typecheck still run (they are self-contained).
 */
export async function verifyLock(rootDir: string, lockId: string, opts: VerifyOptions = {}): Promise<VerificationReport> {
  const lock = loadLock(rootDir, lockId);
  if (!lock) throw new VerifyError(`no such lock: ${lockId} (see \`cdir lock ls\`)`);
  // Sealed contract: verifying against a Lock edited after approval would
  // grade the agent's own amendment — refuse until the user re-approves.
  const seal = sealViolation(rootDir, lock);
  if (seal) throw new VerifyError(seal);
  const baselinePath = opts.baselinePath ?? latestBaselinePath(rootDir, lockId) ?? undefined;
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
  const { index } = await buildIndex(rootDir);
  return verifyWithBaseline(rootDir, lock, baseline, baselineRel, index, opts);
}
