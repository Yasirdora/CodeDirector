/**
 * Lock drafting: `cdir lock new "<utterance>"`.
 *
 * Interactive-free v1: the system resolves anchor symbols from the
 * utterance, computes blast radius, and PROPOSES budget.files (defining
 * files of the top-ranked symbols) plus a suggested deny list (dependency
 * manifests/lockfiles present in the repo, and test files outside the
 * blast radius). The result is written as `status: draft` YAML for the
 * human to edit; nothing is enforced until `cdir lock activate`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { RepoIndex, SymbolInfo } from "../core/types";
import { buildGraph, isTestFile, testFilesFor } from "../core/graph";
import { buildRepoMap, resolveAnchorsDetailed, type AnchorStrength } from "../core/map";
import { VibeCheck, KeepClause, LOCK_SCHEMA_VERSION, DEPENDENCY_MANIFESTS } from "./types";
import { nextLockId, saveLock } from "./store";

export interface DraftOptions {
  goal?: string;
  /** Pre-filled KEEP clauses ("kind:value" strings, already parsed). */
  keep?: KeepClause[];
  /** Pre-filled deny patterns. */
  deny?: string[];
  /** Pre-filled budget files. */
  budgetFiles?: string[];
  /** Optional user verification harness (e.g. "npm test"), run by the verifier. */
  verifyCommand?: string;
  /** Cap on auto-proposed budget files (default 6). */
  maxProposedFiles?: number;
  /** For tests: override createdAt / createdBy. */
  now?: string;
  createdBy?: string;
}

export interface DraftResult {
  lock: VibeCheck;
  path: string;
  anchors: SymbolInfo[];
  /** Files proposed by blast-radius analysis (before any --budget-files override). */
  proposedFiles: string[];
  suggestedDeny: string[];
  /** How strongly the utterance matched (exact / name / lexical / none). */
  anchorStrength: AnchorStrength;
  /** How many deny suggestions were omitted for readability (0 = none). */
  denyOmitted: number;
}

/** Cap on written deny suggestions; the remainder is noted, not listed. */
export const DENY_SUGGESTION_CAP = 8;

/**
 * Compress a long test-file list into directory globs: files under
 * `__tests__/` collapse to `<dir>/__tests__/**`; directories with ≥2 test
 * files collapse to `<dir>/**\/*.test.*` / `*.spec.*`. Falls back to
 * individual paths. Deterministic (sorted output).
 */
export function compressTestPaths(testFiles: string[]): string[] {
  const globs = new Set<string>();
  const singles: string[] = [];
  const byDir = new Map<string, string[]>();
  for (const f of [...testFiles].sort()) {
    const segs = f.split("/");
    const tt = segs.indexOf("__tests__");
    if (tt !== -1) {
      globs.add(segs.slice(0, tt + 1).join("/") + "/**");
      continue;
    }
    const dir = segs.slice(0, -1).join("/");
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  for (const [dir, files] of [...byDir.entries()].sort()) {
    if (files.length < 2) {
      singles.push(...files);
      continue;
    }
    const hasTest = files.some((f) => f.includes(".test."));
    const hasSpec = files.some((f) => f.includes(".spec."));
    if (hasTest) globs.add(`${dir}/**/*.test.*`);
    if (hasSpec) globs.add(`${dir}/**/*.spec.*`);
    for (const f of files) {
      if (!f.includes(".test.") && !f.includes(".spec.")) singles.push(f);
    }
  }
  return [...[...globs].sort(), ...singles.sort()];
}

/** Parse a "--keep" flag value into a KeepClause. Throws on bad form. */
export function parseKeepClause(value: string): KeepClause {
  const idx = value.indexOf(":");
  const kind = idx === -1 ? value : value.slice(0, idx);
  const rest = idx === -1 ? "" : value.slice(idx + 1);
  switch (kind) {
    case "api-unchanged":
      if (!rest) throw new Error(`api-unchanged requires symbol ids: "api-unchanged:<file>#<symbol>"`);
      return { kind, symbols: rest.split(",").map((s) => s.trim()).filter(Boolean) };
    case "output-unchanged":
      if (!rest) throw new Error(`output-unchanged requires a command: "output-unchanged:<command>"`);
      return { kind, command: rest };
    case "no-new-dependency":
      return { kind };
    case "tests-pass":
      if (!rest) throw new Error(`tests-pass requires a glob: "tests-pass:test/**/*.test.ts"`);
      return { kind, glob: rest };
    case "custom":
      if (!rest) throw new Error(`custom requires text: "custom:<text>"`);
      return { kind, text: rest };
    default:
      throw new Error(
        `unknown KEEP kind "${kind}" — a Lock rejects clauses it cannot in principle ` +
          `check (valid: output-unchanged, api-unchanged, no-new-dependency, tests-pass, custom)`,
      );
  }
}

function gitUserName(rootDir: string): string {
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    if (name) return name;
  } catch {
    /* not a git repo or no user.name */
  }
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

/**
 * Draft a Lock from an utterance. Never throws for "no anchors" — the draft
 * is still written (with an empty proposed budget) so the human can edit it.
 */
export function draftLock(rootDir: string, index: RepoIndex, utterance: string, opts: DraftOptions = {}): DraftResult {
  const graph = buildGraph(index);
  const resolution = resolveAnchorsDetailed(graph, utterance);
  const anchors = resolution.anchors;
  const map = buildRepoMap(index, utterance, { top: 30, maxTokens: 4096 });

  // Weak anchors abstain: when nothing name-bearing matched, a proposed
  // budget would be confidently wrong (field-reported on Hono: asking about
  // `compose` proposed unrelated adapter files). Propose nothing and say so.
  const anchorsWeak = resolution.strength === "lexical" || resolution.strength === "none";

  // Proposed budget: defining files of top-ranked symbols, non-test,
  // ordered by rank, capped.
  const cap = opts.maxProposedFiles ?? 6;
  const proposedFiles: string[] = [];
  if (!anchorsWeak) {
    for (const entry of map.entries) {
      const f = entry.symbol.file;
      if (isTestFile(f)) continue;
      if (!proposedFiles.includes(f)) proposedFiles.push(f);
      if (proposedFiles.length >= cap) break;
    }
  }

  // Suggested deny: dependency manifests present at the root, plus test
  // files that are NOT in the blast radius of any anchor (unrelated areas).
  // Compressed to directory globs and capped — on real repos the raw list is
  // hundreds of entries and unreadable (field-reported on Hono: ~140 test
  // files on one line). Omissions are noted in the assumptions, never silent.
  const relatedTests = new Set<string>();
  for (const a of anchors) {
    for (const t of testFilesFor(index, a)) relatedTests.add(t);
  }
  const manifestDeny: string[] = [];
  for (const m of DEPENDENCY_MANIFESTS) {
    if (fs.existsSync(path.join(rootDir, m))) manifestDeny.push(m);
  }
  const unrelatedTests: string[] = [];
  for (const f of Object.keys(index.files).sort()) {
    if (isTestFile(f) && !relatedTests.has(f)) unrelatedTests.push(f);
  }
  const allDeny = [...manifestDeny, ...compressTestPaths(unrelatedTests)];
  const suggestedDeny = allDeny.slice(0, DENY_SUGGESTION_CAP);
  const denyOmitted = allDeny.length - suggestedDeny.length;

  const budgetFiles = opts.budgetFiles && opts.budgetFiles.length > 0 ? opts.budgetFiles : proposedFiles;

  const assumptions: VibeCheck["assumptions"] = [];
  if (anchors.length > 0 && !anchorsWeak) {
    assumptions.push({
      text:
        `Budget proposed automatically from anchors: ${anchors.map((a) => a.qualifiedName).join(", ")} ` +
        `(blast-radius analysis, anchor strength: ${resolution.strength}; review before activating)`,
      source: "system",
      confirmed: false,
    });
  } else if (anchorsWeak && anchors.length > 0) {
    assumptions.push({
      text:
        `Only weak lexical anchors matched (${anchors.map((a) => a.qualifiedName).join(", ")}) — ` +
        `budget left empty on purpose; name the symbols or files you intend to touch (--budget-files)`,
      source: "system",
      confirmed: false,
    });
  } else {
    assumptions.push({
      text: "No anchor symbols matched the utterance; budget left empty — fill it in by hand",
      source: "system",
      confirmed: false,
    });
  }
  if (suggestedDeny.length > 0) {
    assumptions.push({
      text:
        `Deny list suggested automatically (manifests, unrelated test files)` +
        (denyOmitted > 0
          ? ` — truncated for readability: ${denyOmitted} further entr${denyOmitted === 1 ? "y" : "ies"} omitted (mostly test files; add a glob like "src/**/*.test.*" to deny them all)`
          : "; review before activating"),
      source: "system",
      confirmed: false,
    });
  }

  const lock: VibeCheck = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id: nextLockId(rootDir),
    status: "draft",
    utterance,
    goal: opts.goal ?? "TODO — what must be true when this is done",
    interpretation: "TODO — the system's operationalization of the goal (edit to correct it)",
    keep: opts.keep ?? [],
    deny: opts.deny && opts.deny.length > 0 ? opts.deny : suggestedDeny,
    change: "TODO — one-line scope description",
    ...(opts.verifyCommand !== undefined ? { verifyCommand: opts.verifyCommand } : {}),
    budget: {
      files: budgetFiles,
      symbols: [],
      maxFiles: Math.max(budgetFiles.length, 1),
      maxLines: 400,
    },
    accept: [],
    assumptions,
    createdAt: opts.now ?? new Date().toISOString(),
    createdBy: opts.createdBy ?? gitUserName(rootDir),
  };

  const writtenPath = saveLock(rootDir, lock);
  return { lock, path: writtenPath, anchors, proposedFiles, suggestedDeny, anchorStrength: resolution.strength, denyOmitted };
}
