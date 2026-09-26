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
import { workTreeStatusPorcelain } from "../checkpoint";
import { VibeCheck } from "../lock/types";
import { signatureHash } from "../lock/check";
import { runShellProbe, sha256 } from "./probe";
import { currentHead, listHidden, runIsolated, snapshotWorkTree, WorkTreeSnapshot } from "./tree";
import { probeDiagnostics } from "./diagnostics";
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

/** Timestamp slug shared by the baseline JSON file and its tree directory. */
function baselineStamp(capturedAt: string): string {
  return capturedAt.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
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
  capturedAt: string,
  snap: WorkTreeSnapshot,
): string | undefined {
  const untracked = new Set(snap.untracked);
  const dir = path.join(baselinesDir(rootDir), `${lockId}-${baselineStamp(capturedAt)}`, "tree");
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
  const signatures: Record<string, string> = {};
  const graph = buildGraph(index);
  for (const clause of lock.keep) {
    if (clause.kind !== "api-unchanged") continue;
    for (const id of clause.symbols ?? []) {
      const sym = graph.symbols.get(id);
      if (sym) signatures[id] = signatureHash(sym.signature);
    }
  }

  const domains = opts.domains ?? defaultDomains();
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
        stdoutSha256: sha256(probe.stdout),
        stderrSha256: sha256(probe.stderr),
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
        diagnostics[check.id] = tc.probe.exitCode === 0 ? [] : check.parse(tc.probe.stdout).map((e) => e.key);
      }
    }
  }

  const status = workTreeStatusPorcelain(rootDir);
  const snap = snapshotWorkTree(rootDir);
  const capturedAt = new Date().toISOString();
  const treeDir = writeBaselineTree(rootDir, lock.id, capturedAt, snap);
  return {
    lockId: lock.id,
    capturedAt,
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
  };
}

export function saveBaseline(rootDir: string, baseline: Baseline): string {
  fs.mkdirSync(baselinesDir(rootDir), { recursive: true });
  const p = path.join(baselinesDir(rootDir), `${baseline.lockId}-${baselineStamp(baseline.capturedAt)}.json`);
  fs.writeFileSync(p, stableStringify(baseline), "utf8");
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
 * Latest baseline file for a lock (by filename, which embeds the capture
 * timestamp), or null when the lock has never been run/baselined.
 */
export function latestBaselinePath(rootDir: string, lockId: string): string | null {
  const dir = baselinesDir(rootDir);
  if (!fs.existsSync(dir)) return null;
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${lockId}-`) && f.endsWith(".json"))
    .sort();
  return matches.length > 0 ? path.join(dir, matches[matches.length - 1]) : null;
}
