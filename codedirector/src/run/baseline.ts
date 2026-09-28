/**
 * Baseline capture (blueprint §16 "Oracle separation"): the KEEP surface is
 * snapshotted BEFORE the command runs and written to
 * .codedirector/baselines/ — gitignored, i.e. outside the source tree the
 * executed command is expected to modify. The executor has no business
 * there; any check is a diff against this pre-captured state, not against
 * anything the executor could have rewritten.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RepoIndex } from "../core/types";
import { buildGraph } from "../core/graph";
import { hashContent } from "../core/builder";
import { indexDir, stableStringify } from "../core/store";
import { newRecordId, writeFileAtomic } from "../core/ids";
import { buildIndex } from "../core/builder";
import { workTreeStatusPorcelain } from "../checkpoint";
import { VibeCheck } from "../lock/types";
import { signatureHash } from "../lock/check";
import { runShellProbe } from "./probe";
import { currentHead, listHidden, runIsolated, snapshotWorkTree, WorkTreeSnapshot } from "./tree";
import { probeDiagnostics } from "./diagnostics";
import { captureIgnoreRules, IgnoreRules } from "./ignored";
import { defaultDomains, DomainRegistry } from "../domain/registry";
import { ProbePutBack } from "../verify/types";

/**
 * Pre-change state of one output-unchanged KEEP clause: the clause's command
 * was run at baseline time and its stdout hashed. At verify time the command
 * is re-run and the hashes compared — a differential, measured check.
 */
export interface BaselineOutput {
  command: string;
  /** Exit code at baseline time; null when the command could not run. */
  exitCode: number | null;
  /** sha256 of stdout at baseline time; absent when the command failed. */
  stdoutSha256?: string;
  /** sha256 of stderr at baseline time. */
  stderrSha256?: string;
  /** Why no hash was captured (timeout, spawn error, non-zero exit). */
  error?: string;
}

export interface HiddenHash {
  path: string;
  flag: "S" | "h";
  hash: string;
}

export interface Baseline {
  lockId: string;
  capturedAt: string;
  /** Unique record stamp naming the baseline file and its tree directory (IL-0030). */
  stamp?: string;
  /** Checkpoint tag taken just before this baseline, when run via `cdir run`. */
  checkpointTag?: string;
  /** HEAD sha at capture — classification diffs against this, not "current HEAD". */
  head?: string;
  /** api-unchanged KEEP surface: symbol id -> sha256 of its signature. */
  signatures: Record<string, string>;
  /** no-new-dependency surface: manifest relpath -> fingerprint. */
  manifests: Record<string, string>;
  /** output-unchanged KEEP surface: command -> captured stdout/stderr hashes. */
  outputs?: Record<string, BaselineOutput>;
  /** Raw `git status --porcelain` at capture time and its sha256. */
  gitStatus: string;
  gitStatusHash: string;
  /** git-root-relative path -> content sha256 of dirty / untracked / hidden files. */
  workTreeHashes?: Record<string, string>;
  /** skip-worktree / assume-unchanged files at capture. */
  hidden?: HiddenHash[];
  /**
   * RootDir-relative directory holding a byte copy of every TRACKED file
   * that was dirty vs HEAD at capture (tree/<gitPath> underneath). Line
   * counting diffs the post-run file against its copy, so pre-existing dirt
   * never counts against maxLines. Absent when the tree was clean.
   */
  treeDir?: string;
  /**
   * Compiler diagnostics at capture, per diagnostics check id (e.g.
   * "node.tsc"), one key per diagnostic (file, code, message — no position).
   * The typecheck rung fails a run only for diagnostics not in its check's
   * list. A check is absent when no result was possible at capture (not
   * applicable, no compiler, timeout); the whole map is absent when none
   * was, or the rung was switched off. An empty list means clean.
   */
  diagnostics?: Record<string, string[]>;
  /**
   * The text of every ignore source at capture (each .gitignore, and
   * .git/info/exclude). A run that changes them is checked for files its
   * new rules hide from git (run/ignored.ts). Absent outside git and in
   * baselines captured before this existed.
   */
  ignoreRules?: IgnoreRules;
  /**
   * Written by releases before the domain split: tsc's errors. Read through
   * a check's `legacyBaselineField`; never written.
   */
  typecheckErrors?: string[];
}

export interface BaselineOptions {
  /** Per-command timeout for output-unchanged probes (default 30s). */
  outputTimeoutMs?: number;
  /** Record the pre-run typecheck errors (default true; mirrors VerifyOptions.typecheck). */
  typecheck?: boolean;
  /** tsc --noEmit timeout (default 120s). */
  typecheckTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Collects what the baseline's probes changed and had put back. */
  putBack?: ProbePutBack[];
  /** Domains whose manifests and checks the baseline captures (default: the built-in ones). */
  domains?: DomainRegistry;
}

export function baselinesDir(rootDir: string): string {
  return path.join(indexDir(rootDir), "baselines");
}

/** Unique, sortable stamp shared by the baseline JSON file and its tree directory. */
function baselineStamp(capturedAt: string): string {
  return newRecordId(new Date(capturedAt));
}

/**
 * Byte copies of the tracked-dirty files from the work-tree snapshot (the
 * run's line delta is measured against these, not vs HEAD). Storage stays
 * proportional: clean files are exact vs HEAD and need no copy, untracked
 * files are covered by the untracked-counting rule. Returns the
 * rootDir-relative directory, or undefined when nothing was dirty.
 */
function writeBaselineTree(
  rootDir: string,
  lockId: string,
  stamp: string,
  snap: WorkTreeSnapshot,
): string | undefined {
  const untracked = new Set(snap.untracked);
  const dir = path.join(baselinesDir(rootDir), `${lockId}-${stamp}`, "tree");
  let wrote = 0;
  for (const [p, bytes] of Object.entries(snap.contents)) {
    if (untracked.has(p)) continue;
    if (p.split("/").includes(".codedirector")) continue;
    const dest = path.join(dir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    wrote++;
  }
  if (wrote === 0) return undefined;
  return path.relative(rootDir, dir).split(path.sep).join("/");
}

export function captureBaseline(
  rootDir: string,
  lock: VibeCheck,
  index: RepoIndex,
  checkpointTag?: string,
  opts: BaselineOptions = {},
): Baseline {
  const domains = opts.domains ?? defaultDomains();
  const signatures: Record<string, string> = {};
  const graph = buildGraph(index, domains);
  for (const clause of lock.keep) {
    if (clause.kind !== "api-unchanged") continue;
    for (const id of clause.symbols ?? []) {
      const sym = graph.symbols.get(id);
      if (sym) signatures[id] = signatureHash(sym.signature);
    }
  }

  const manifests: Record<string, string> = {};
  const wantsManifestDiff = lock.keep.some((c) => c.kind === "no-new-dependency");
  if (wantsManifestDiff) {
    for (const { path: m } of domains.dependencyManifests()) {
      const p = path.join(rootDir, m);
      if (fs.existsSync(p)) {
        manifests[m] = domains.manifestFingerprint(m, fs.readFileSync(p, "utf8"));
      }
    }
  }

  // output-unchanged: run each clause's command NOW (pre-change) and pin its
  // stdout+stderr hashes. The probe is isolated — mutations it makes are
  // restored so the command under test sees the real pre-change tree.
  const outputTimeout = opts.outputTimeoutMs ?? 30_000;
  const outputs: Record<string, BaselineOutput> = {};
  let capturedAnyOutput = false;
  for (const clause of lock.keep) {
    if (clause.kind !== "output-unchanged" || !clause.command) continue;
    capturedAnyOutput = true;
    const probe = runIsolated(
      rootDir,
      () => runShellProbe(rootDir, clause.command!, outputTimeout),
      (p) => opts.putBack?.push({ probe: `baseline · output-unchanged · ${clause.command}`, ...p }),
    );
    if (probe.error || probe.timedOut) {
      outputs[clause.command] = {
        command: clause.command,
        exitCode: probe.exitCode,
        error: probe.timedOut ? `timed out after ${outputTimeout}ms` : (probe.error ?? "spawn failed"),
      };
    } else if (probe.exitCode !== 0) {
      outputs[clause.command] = {
        command: clause.command,
        exitCode: probe.exitCode,
        error: `exited ${probe.exitCode} at baseline time — no output hash captured`,
      };
    } else {
      outputs[clause.command] = {
        command: clause.command,
        exitCode: probe.exitCode,
        // Hashes of the whole output: the text a probe returns is capped.
        stdoutSha256: probe.stdoutSha256,
        stderrSha256: probe.stderrSha256,
      };
    }
  }

  // Pre-run compiler diagnostics, so the run is judged only on the ones it adds.
  const diagnostics: Record<string, string[]> = {};
  if (opts.typecheck !== false) {
    for (const check of domains.diagnosticsChecks()) {
      const tc = probeDiagnostics(rootDir, check, {
        timeoutMs: opts.typecheckTimeoutMs,
        env: opts.env,
        onPutBack: (p) => opts.putBack?.push({ probe: `baseline · ${check.subject}`, ...p }),
      });
      if (tc.kind === "ran") {
        diagnostics[check.id] = tc.probe.exitCode === 0 ? [] : check.parse(tc.probe.stdout, tc.probe.stderr).map((e) => e.key);
      }
    }
  }

  const status = workTreeStatusPorcelain(rootDir);
  const snap = snapshotWorkTree(rootDir);
  const ignoreRules = captureIgnoreRules(rootDir);
  const capturedAt = new Date().toISOString();
  // One stamp names both the JSON file and its tree directory, so they pair
  // by construction; two captures in the same second get two stamps.
  const stamp = baselineStamp(capturedAt);
  const treeDir = writeBaselineTree(rootDir, lock.id, stamp, snap);
  return {
    lockId: lock.id,
    capturedAt,
    stamp,
    checkpointTag,
    head: currentHead(rootDir) ?? undefined,
    signatures,
    manifests,
    ...(capturedAnyOutput ? { outputs } : {}),
    gitStatus: status,
    gitStatusHash: hashContent(status),
    workTreeHashes: snap.hashes,
    hidden: listHidden(rootDir),
    ...(treeDir !== undefined ? { treeDir } : {}),
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    ...(ignoreRules ? { ignoreRules } : {}),
  };
}

export function saveBaseline(rootDir: string, baseline: Baseline): string {
  fs.mkdirSync(baselinesDir(rootDir), { recursive: true });
  const stamp = baseline.stamp ?? baselineStamp(baseline.capturedAt);
  const p = path.join(baselinesDir(rootDir), `${baseline.lockId}-${stamp}.json`);
  writeFileAtomic(p, stableStringify(baseline));
  return p;
}

/** sha256 of a saved baseline file — the tamper-detection primitive. */
export function baselineFileHash(baselinePath: string): string {
  return hashContent(fs.readFileSync(baselinePath, "utf8"));
}

/** Load a baseline from an explicit path. Throws on unreadable JSON. */
export function loadBaseline(baselinePath: string): Baseline {
  return JSON.parse(fs.readFileSync(baselinePath, "utf8")) as Baseline;
}

/**
 * Latest per-run baseline snapshot for a lock (by filename, whose leading
 * stamp sorts in capture order), or null when the lock has none. The task
 * baseline is a separate file (`<id>-task.json`) and its archives
 * (`<id>-task-archive-*`) are excluded here.
 */
export function latestBaselinePath(rootDir: string, lockId: string): string | null {
  const dir = baselinesDir(rootDir);
  if (!fs.existsSync(dir)) return null;
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${lockId}-`) && f.endsWith(".json"))
    .filter((f) => f !== taskBaselineFileName(lockId) && !f.startsWith(`${lockId}-task-archive-`))
    .sort();
  return matches.length > 0 ? path.join(dir, matches[matches.length - 1]) : null;
}

// ---------------------------------------------------------------------
// The task baseline (IL-0031)
//
// One immutable reference per lock, captured at task start: the first
// `cdir run`, or `cdir checkpoint IL-XXXX` for work done by direct edits.
// Every attempt is judged cumulatively against it — a retry reuses the
// reference instead of minting a fresh one, which is what let a broken
// promise become the accepted baseline before this existed. `cdir lock
// rebase` moves the reference explicitly, archiving what it replaces.

export function taskBaselineFileName(lockId: string): string {
  return `${lockId}-task.json`;
}

export function taskBaselinePath(rootDir: string, lockId: string): string {
  return path.join(baselinesDir(rootDir), taskBaselineFileName(lockId));
}

/** The task baseline for a lock, or null when none was captured (or it is unreadable). */
export function loadTaskBaseline(rootDir: string, lockId: string): Baseline | null {
  try {
    return loadBaseline(taskBaselinePath(rootDir, lockId));
  } catch {
    return null;
  }
}

function taskTempName(p: string): string {
  return path.join(
    path.dirname(p),
    `.${path.basename(p)}.tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

/**
 * Write the task baseline if it does not exist yet. Atomic (temp + link) and
 * exclusive (link fails on an existing target), so two sessions racing to
 * start the same task cannot mint two references. Returns the path and
 * whether this call created it.
 */
export function saveTaskBaseline(rootDir: string, baseline: Baseline): { path: string; created: boolean } {
  fs.mkdirSync(baselinesDir(rootDir), { recursive: true });
  const p = taskBaselinePath(rootDir, baseline.lockId);
  const tmp = taskTempName(p);
  fs.writeFileSync(tmp, stableStringify(baseline));
  try {
    fs.linkSync(tmp, p);
    return { path: p, created: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { path: p, created: false };
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * A lock that predates the task baseline adopts its OLDEST recorded per-run
 * baseline — the tree as it stood before the first attempt — rather than
 * silently accepting the present tree. Null when there is nothing to adopt.
 */
export function deriveTaskBaselineFromLegacy(
  rootDir: string,
  lockId: string,
): { baseline: Baseline; source: string } | null {
  const dir = baselinesDir(rootDir);
  if (!fs.existsSync(dir)) return null;
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${lockId}-`) && f.endsWith(".json"))
    .filter((f) => f !== taskBaselineFileName(lockId) && !f.startsWith(`${lockId}-task-archive-`))
    .sort();
  if (candidates.length === 0) return null;
  const source = candidates[0];
  try {
    const adopted = loadBaseline(path.join(dir, source));
    saveTaskBaseline(rootDir, adopted);
    return { baseline: loadTaskBaseline(rootDir, lockId) ?? adopted, source };
  } catch {
    return null;
  }
}

/**
 * Move the task baseline to the present tree — the explicit revision. The
 * replaced reference is archived beside it (never lost), and this is the
 * only path that moves it: retries reuse, rebases move.
 */
export async function rebaseTaskBaseline(
  rootDir: string,
  lock: VibeCheck,
  opts: BaselineOptions = {},
): Promise<{ path: string; archived?: string; capturedAt: string }> {
  const existing = loadTaskBaseline(rootDir, lock.id);
  const domains = opts.domains ?? defaultDomains();
  const { index } = await buildIndex(rootDir, { domains });
  const fresh = captureBaseline(rootDir, lock, index, undefined, opts);
  let archived: string | undefined;
  if (existing) {
    const dir = baselinesDir(rootDir);
    archived = path.join(dir, `${lock.id}-task-archive-${existing.stamp ?? baselineStamp(existing.capturedAt)}.json`);
    fs.renameSync(taskBaselinePath(rootDir, lock.id), archived);
  }
  saveTaskBaseline(rootDir, fresh);
  return { path: taskBaselinePath(rootDir, lock.id), ...(archived ? { archived } : {}), capturedAt: fresh.capturedAt };
}
