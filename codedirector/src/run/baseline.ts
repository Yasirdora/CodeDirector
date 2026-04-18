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

export interface Baseline {
  lockId: string;
  capturedAt: string;
  /** Checkpoint tag taken just before this baseline, when run via `cdir run`. */
  checkpointTag?: string;
  /** api-unchanged KEEP surface: symbol id -> sha256 of its signature. */
  signatures: Record<string, string>;
  /** no-new-dependency surface: manifest relpath -> sha256 of contents. */
  manifests: Record<string, string>;
  /** Raw `git status --porcelain` at capture time and its sha256. */
  gitStatus: string;
  gitStatusHash: string;
}

export function baselinesDir(rootDir: string): string {
  return path.join(indexDir(rootDir), "baselines");
}

export function captureBaseline(rootDir: string, lock: IntentLock, index: RepoIndex, checkpointTag?: string): Baseline {
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

  const status = workTreeStatusPorcelain(rootDir);
  return {
    lockId: lock.id,
    capturedAt: new Date().toISOString(),
    checkpointTag,
    signatures,
    manifests,
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
