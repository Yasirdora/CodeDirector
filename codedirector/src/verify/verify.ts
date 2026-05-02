/**
 * The verification ladder (blueprint §17), applied after a change:
 *
 *   1. Structural (proven)   — api-unchanged signature hashes and
 *                              no-new-dependency manifest hashes diffed
 *                              against the pre-captured baseline.
 *   2. Typecheck (proven)    — `tsc --noEmit` when a tsconfig exists and a
 *                              compiler is available; otherwise Unchecked
 *                              with the reason named.
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
import { IntentLock, DEPENDENCY_MANIFESTS } from "../lock/types";
import { loadLock } from "../lock/store";
import { signatureHash } from "../lock/check";
import { matchPath } from "../lock/glob";
import { Baseline, latestBaselinePath, loadBaseline } from "../run/baseline";
import { runArgvProbe, runShellProbe, sha256 } from "../run/probe";
import {
  countByClass,
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
  /** Per-test-run and verifyCommand timeout (default 60s). */
  testTimeoutMs?: number;
  /** Per-output-command timeout (default 30s). */
  outputTimeoutMs?: number;
  /** Environment for spawned checks (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".codedirector"]);

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
  lock: IntentLock,
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
  lock: IntentLock,
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
    const after = hashContent(fs.readFileSync(p, "utf8"));
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

function localTsc(rootDir: string): string | null {
  const p = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
  return fs.existsSync(p) ? p : null;
}

/** First diagnostic lines from compiler output (error lines preferred). */
function compilerDiagnostics(stdout: string, stderr: string): string {
  const errorLines = stdout.split("\n").filter((l) => l.includes("error TS")).slice(0, 5);
  if (errorLines.length > 0) return `: ${errorLines.join(" · ")}`;
  const any = `${stdout}\n${stderr}`.split("\n").filter((l) => l.trim()).slice(0, 3);
  return any.length > 0 ? ` — output: ${any.join(" · ").slice(0, 300)}` : "";
}

function verifyTypecheck(rootDir: string, opts: VerifyOptions): VerificationItem[] {
  if (opts.typecheck === false) return [];
  if (!fs.existsSync(path.join(rootDir, "tsconfig.json"))) return [];
  const subject = "typecheck · tsc --noEmit";
  const timeout = opts.typecheckTimeoutMs ?? 120_000;
  const tsc = localTsc(rootDir);
  if (tsc) {
    const probe = runArgvProbe(rootDir, [process.execPath, tsc, "--noEmit", "-p", "."], timeout, opts.env);
    if (probe.timedOut) {
      return [uncheckedItem("typecheck", subject, `tsc --noEmit timed out after ${timeout}ms`)];
    }
    if (probe.error || probe.exitCode === null) {
      return [uncheckedItem("typecheck", subject, `tsc could not run: ${probe.error ?? "spawn failed"}`)];
    }
    if (probe.exitCode === 0) {
      return [{ source: "typecheck", subject, verdict: "held", evidenceClass: "proven", detail: "tsc --noEmit clean", artifactRef: `node node_modules/typescript/bin/tsc --noEmit -p . → exit 0` }];
    }
    const firstErrors = compilerDiagnostics(probe.stdout, probe.stderr);
    return [{
      source: "typecheck",
      subject,
      verdict: "violated",
      evidenceClass: "measured",
      detail: `tsc --noEmit failed (exit ${probe.exitCode})${firstErrors}`,
      artifactRef: `node node_modules/typescript/bin/tsc --noEmit -p . → exit ${probe.exitCode}`,
    }];
  }
  // No local install: probe npx without allowing downloads.
  const probe = runShellProbe(rootDir, "npx --no-install tsc --noEmit", timeout, opts.env);
  const out = `${probe.stdout}\n${probe.stderr}`;
  if (probe.error || probe.timedOut || /could not determine executable|npm error|not installed|not the tsc command/i.test(out)) {
    return [uncheckedItem("typecheck", subject, "typescript compiler unavailable (no node_modules/typescript; `npx --no-install tsc` found no real compiler)")];
  }
  if (probe.exitCode === 0) {
    return [{ source: "typecheck", subject, verdict: "held", evidenceClass: "proven", detail: "tsc --noEmit clean", artifactRef: `npx --no-install tsc --noEmit → exit 0` }];
  }
  const firstErrors = compilerDiagnostics(probe.stdout, probe.stderr);
  return [{
    source: "typecheck",
    subject,
    verdict: "violated",
    evidenceClass: "measured",
    detail: `tsc --noEmit failed (exit ${probe.exitCode})${firstErrors}`,
    artifactRef: `npx --no-install tsc --noEmit → exit ${probe.exitCode}`,
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

function verifyTestsPass(rootDir: string, lock: IntentLock, opts: VerifyOptions): VerificationItem[] {
  const items: VerificationItem[] = [];
  const timeout = opts.testTimeoutMs ?? 60_000;
  for (const clause of lock.keep) {
    if (clause.kind !== "tests-pass") continue;
    const glob = clause.glob ?? "";
    const subject = `tests-pass · ${glob}`;
    const files = expandGlob(rootDir, glob);
    if (files.length === 0) {
      items.push(uncheckedItem("keep-clause", subject, `glob matched no test files: ${glob}`, clause.kind));
      continue;
    }
    const probe = runArgvProbe(rootDir, [process.execPath, "--test", "--test-reporter=tap", ...files], timeout, opts.env);
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

function verifyCommand(rootDir: string, lock: IntentLock, opts: VerifyOptions): VerificationItem[] {
  if (!lock.verifyCommand) return [];
  const subject = `verifyCommand · ${lock.verifyCommand}`;
  const timeout = opts.testTimeoutMs ?? 60_000;
  const probe = runShellProbe(rootDir, lock.verifyCommand, timeout, opts.env);
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

function verifyOutputUnchanged(rootDir: string, lock: IntentLock, baseline: Baseline | null, baselineRel: string | undefined, opts: VerifyOptions): VerificationItem[] {
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
    const probe = runShellProbe(rootDir, cmd, timeout, opts.env);
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
    const after = sha256(probe.stdout);
    items.push(
      after === captured.stdoutSha256
        ? { source: "keep-clause", clauseKind: clause.kind, subject, verdict: "held", evidenceClass: "measured", detail: `output byte-identical (sha256 ${after.slice(0, 12)}…)`, artifactRef }
        : { source: "keep-clause", clauseKind: clause.kind, subject, verdict: "violated", evidenceClass: "measured", detail: `output changed: sha256 ${captured.stdoutSha256.slice(0, 12)}… → ${after.slice(0, 12)}…`, artifactRef },
    );
  }
  return items;
}

// ---------------------------------------------------------------------
// Rung 5 — custom (always unchecked; the human judges)

function verifyCustom(lock: IntentLock): VerificationItem[] {
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
  lock: IntentLock,
  baseline: Baseline | null,
  baselineRel: string | undefined,
  indexAfter: RepoIndex,
  opts: VerifyOptions = {},
): VerificationReport {
  const items: VerificationItem[] = [
    ...verifyApiUnchanged(lock, baseline, baselineRel, indexAfter),
    ...verifyNoNewDependency(rootDir, lock, baseline, baselineRel),
    ...verifyTypecheck(rootDir, opts),
    ...verifyTestsPass(rootDir, lock, opts),
    ...verifyCommand(rootDir, lock, opts),
    ...verifyOutputUnchanged(rootDir, lock, baseline, baselineRel, opts),
    ...verifyCustom(lock),
  ];
  const violations = items
    .filter((i) => i.verdict === "violated")
    .map((i) => (i.source === "keep-clause" ? `KEEP ${i.clauseKind}: ${i.detail}` : `VERIFY ${i.source}: ${i.detail}`));
  return {
    lockId: lock.id,
    verifiedAt: new Date().toISOString(),
    ...(baselineRel !== undefined ? { baselinePath: baselineRel } : {}),
    items,
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
  const baselinePath = opts.baselinePath ?? latestBaselinePath(rootDir, lockId) ?? undefined;
  const baseline = baselinePath ? loadBaseline(baselinePath) : null;
  const baselineRel = baselinePath ? path.relative(rootDir, baselinePath).split(path.sep).join("/") : undefined;
  const { index } = await buildIndex(rootDir);
  return verifyWithBaseline(rootDir, lock, baseline, baselineRel, index, opts);
}
