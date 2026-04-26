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
import { IntentLock, DEPENDENCY_MANIFESTS } from "../lock/types";
import { signatureHash } from "../lock/check";
import { runShellProbe, sha256 } from "./probe";

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
  /** Why no hash was captured (timeout, spawn error, non-zero exit). */
  error?: string;
}

export interface Baseline {
  lockId: string;
  capturedAt: string;
  /** Checkpoint tag taken just before this baseline, when run via `cdir run`. */
  checkpointTag?: string;
  /** api-unchanged KEEP surface: symbol id -> sha256 of its signature. */
  signatures: Record<string, string>;
  /** no-new-dependency surface: manifest relpath -> sha256 of contents. */
  manifests: Record<string, string>;
  /** output-unchanged KEEP surface: command -> captured stdout hash. */
  outputs?: Record<string, BaselineOutput>;
  /** Raw `git status --porcelain` at capture time and its sha256. */
  gitStatus: string;
  gitStatusHash: string;
}

export interface BaselineOptions {
  /** Per-command timeout for output-unchanged probes (default 30s). */
  outputTimeoutMs?: number;
}

export function baselinesDir(rootDir: string): string {
  return path.join(indexDir(rootDir), "baselines");
}

export function captureBaseline(
  rootDir: string,
  lock: IntentLock,
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

  const manifests: Record<string, string> = {};
  const wantsManifestDiff = lock.keep.some((c) => c.kind === "no-new-dependency");
  if (wantsManifestDiff) {
    for (const m of DEPENDENCY_MANIFESTS) {
      const p = path.join(rootDir, m);
      if (fs.existsSync(p)) manifests[m] = hashContent(fs.readFileSync(p, "utf8"));
    }
  }

  // output-unchanged: run each clause's command NOW (pre-change) and pin its
  // stdout hash — the pre-state is gone by verify time, so it must be
  // captured here, outside the source tree.
  const outputTimeout = opts.outputTimeoutMs ?? 30_000;
  const outputs: Record<string, BaselineOutput> = {};
  let capturedAnyOutput = false;
  for (const clause of lock.keep) {
    if (clause.kind !== "output-unchanged" || !clause.command) continue;
    capturedAnyOutput = true;
    const probe = runShellProbe(rootDir, clause.command, outputTimeout);
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
      };
    }
  }

  const status = workTreeStatusPorcelain(rootDir);
  return {
    lockId: lock.id,
    capturedAt: new Date().toISOString(),
    checkpointTag,
    signatures,
    manifests,
    ...(capturedAnyOutput ? { outputs } : {}),
    gitStatus: status,
    gitStatusHash: hashContent(status),
  };
}

export function saveBaseline(rootDir: string, baseline: Baseline): string {
  fs.mkdirSync(baselinesDir(rootDir), { recursive: true });
  const ts = baseline.capturedAt.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const p = path.join(baselinesDir(rootDir), `${baseline.lockId}-${ts}.json`);
  fs.writeFileSync(p, stableStringify(baseline), "utf8");
  return p;
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
