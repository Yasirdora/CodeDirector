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
import { buildRepoMap, resolveAnchorsDetailed, type AnchorMatch, type AnchorStrength } from "../core/map";
import { INDEXABLE_EXTENSIONS } from "../core/walk";
import { defaultDomains, DomainRegistry } from "../domain/registry";
import { VibeCheck, KeepClause, LOCK_SCHEMA_VERSION } from "./types";
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
  /** Optional timeout (ms) for tests-pass runs and verifyCommand. */
  verifyTimeoutMs?: number;
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
  /** Every anchor, with the file and the token that put it there. */
  anchorDefense: AnchorDefense[];
  /** Whether the human should confirm the territory before trusting it. */
  confidence: AnchorConfidence;
  /** How many deny suggestions were omitted for readability (0 = none). */
  denyOmitted: number;
}

/** Cap on written deny suggestions; the remainder is noted, not listed. */
export const DENY_SUGGESTION_CAP = 8;

/** The words a draft says when its own territory should be confirmed first. */
export const LOW_CONFIDENCE_FLAG = "low confidence — confirm territory with the human";

/** One anchor, defended: where it came from and what put it there. */
export interface AnchorDefense {
  symbol: string;
  file: string;
  token: string;
  how: AnchorMatch["how"];
  language: string;
  /** One line, readable without opening the file. */
  line: string;
}

/** Whether the proposed territory should be confirmed before it is trusted. */
export interface AnchorConfidence {
  low: boolean;
  reasons: string[];
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".swift": "Swift", ".m": "Objective-C", ".mm": "Objective-C++", ".h": "C/Obj-C header",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".php": "PHP",
  ".java": "Java", ".kt": "Kotlin", ".scala": "Scala", ".cs": "C#", ".dart": "Dart",
  ".c": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++",
};

/** The language a path belongs to, or "other" when it is not source we name. */
export function languageOf(file: string): string {
  const dot = file.lastIndexOf(".");
  if (dot === -1) return "other";
  return LANGUAGE_BY_EXT[file.slice(dot).toLowerCase()] ?? "other";
}

/**
 * Whether the walker can parse any file of this language at all.
 *
 * The difference between "the anchors landed in the wrong language" and
 * "cdir cannot see this repo" — and the draft should not say the first when
 * it means the second.
 */
export function isIndexableLanguage(language: string): boolean {
  for (const [ext, lang] of Object.entries(LANGUAGE_BY_EXT)) {
    if (lang === language && INDEXABLE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

export interface PluralityLanguage {
  language: string | null;
  /** Why there is no answer, when there is none. */
  reason?: string;
}

/**
 * The repo's own language, by tracked-file count.
 *
 * Read from `git ls-files`, never from the index. The walker only indexes
 * TypeScript and JavaScript (`INDEXABLE_EXTENSIONS`), so an index histogram
 * answers "TypeScript" for a Swift app and this signal could never fire —
 * and that blindness is the bug itself: a SwiftUI task drew a TypeScript
 * budget because the Swift was never in front of the drafter. Degrades the
 * way co-change does: no git, no signal, and it says so.
 */
export function pluralityLanguage(rootDir: string): PluralityLanguage {
  let listing: string;
  try {
    listing = execFileSync("git", ["ls-files"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return { language: null, reason: "not a git repository — territory not checked" };
  }
  const counts = new Map<string, number>();
  for (const f of listing.split("\n")) {
    if (!f) continue;
    const lang = languageOf(f);
    if (lang === "other") continue;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return { language: null, reason: "no recognised source files tracked — territory not checked" };
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { language: ranked[0][0] };
}

/** Turn raw anchor provenance into lines a human can judge. */
export function defendAnchors(matches: AnchorMatch[]): AnchorDefense[] {
  return matches.map((m) => {
    const language = languageOf(m.symbol.file);
    // A fragment can match the bare name OR the qualified one; say which,
    // or the defence misreports its own evidence ("line" was never inside
    // "describe" — it was inside "ImagePipeline.describe").
    const held = m.symbol.name.toLowerCase().includes(m.token)
      ? m.symbol.name
      : m.symbol.qualifiedName;
    const why =
      m.how === "exact"
        ? "the utterance names it exactly"
        : m.how === "whole"
          ? `"${m.token}" is its whole name`
          : m.how === "part"
            ? `"${m.token}" only occurs inside "${held}"`
            : `"${m.token}" appears somewhere in its name or path`;
    return {
      symbol: m.symbol.qualifiedName,
      file: m.symbol.file,
      token: m.token,
      how: m.how,
      language,
      line: `${m.symbol.qualifiedName} — ${m.symbol.file} (${language}); ${why}`,
    };
  });
}

/**
 * Two signals, either of which asks the human to confirm the territory.
 *
 * Substring-only: every anchor arrived through a fragment of a name, which
 * is what an incidental English word does ("flag", "time", "work").
 * Territory drift: every anchor sits outside the language the repo is
 * mostly written in, so the files the words point at may not be indexed.
 */
export function judgeConfidence(
  defenses: AnchorDefense[],
  plurality: PluralityLanguage,
): AnchorConfidence {
  const reasons: string[] = [];
  if (defenses.length === 0) return { low: false, reasons };
  if (defenses.every((d) => d.how === "part")) {
    reasons.push(
      "every anchor matched only as a fragment of a symbol name " +
        `(${defenses.map((d) => `"${d.token}" in ${d.symbol}`).join(", ")}) — ` +
        "an incidental word can do this",
    );
  }
  if (plurality.language) {
    const langs = [...new Set(defenses.map((d) => d.language))].sort();
    if (!langs.includes(plurality.language)) {
      // "may not be indexed" is false modesty when the answer is none of it.
      reasons.push(
        isIndexableLanguage(plurality.language)
          ? `every anchor is ${langs.join("/")} but this repo is mostly ${plurality.language} — ` +
            "the files those words point at may not be indexed at all"
          : `this repo is mostly ${plurality.language} and cdir indexes no ${plurality.language} — ` +
            "the budget cannot come from anchors; name the files you mean",
      );
    }
  }
  return { low: reasons.length > 0, reasons };
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
export function draftLock(
  rootDir: string,
  index: RepoIndex,
  utterance: string,
  opts: DraftOptions = {},
  domains: DomainRegistry = defaultDomains(),
): DraftResult {
  const graph = buildGraph(index, domains);
  const resolution = resolveAnchorsDetailed(graph, utterance);
  const anchors = resolution.anchors;
  const anchorDefense = defendAnchors(resolution.matches);
  const confidence = judgeConfidence(anchorDefense, pluralityLanguage(rootDir));
  const map = buildRepoMap(index, utterance, { top: 30, maxTokens: 4096, domains });

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
      if (isTestFile(f, domains)) continue;
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
    for (const t of testFilesFor(index, a, domains)) relatedTests.add(t);
  }
  const manifestDeny: string[] = [];
  for (const { path: m } of domains.dependencyManifests()) {
    if (fs.existsSync(path.join(rootDir, m))) manifestDeny.push(m);
  }
  const unrelatedTests: string[] = [];
  for (const f of Object.keys(index.files).sort()) {
    if (isTestFile(f, domains) && !relatedTests.has(f)) unrelatedTests.push(f);
  }
  const allDeny = [...manifestDeny, ...domains.compressTestPaths(unrelatedTests)];
  const suggestedDeny = allDeny.slice(0, DENY_SUGGESTION_CAP);
  const denyOmitted = allDeny.length - suggestedDeny.length;

  const budgetFiles = opts.budgetFiles && opts.budgetFiles.length > 0 ? opts.budgetFiles : proposedFiles;

  // The flag leads the list: a human skimming a draft reads the first line
  // of it, and this is the line that says do not trust the rest yet.
  const assumptions: VibeCheck["assumptions"] = [];
  if (confidence.low) {
    assumptions.push({
      text: `${LOW_CONFIDENCE_FLAG}: ${confidence.reasons.join("; ")}`,
      source: "system",
      confirmed: false,
    });
  }
  if (anchorDefense.length > 0) {
    assumptions.push({
      text: `Anchors defended — ${anchorDefense.map((d) => d.line).join(" · ")}`,
      source: "system",
      confirmed: false,
    });
  }
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
    ...(opts.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: opts.verifyTimeoutMs } : {}),
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
  return {
    lock,
    path: writtenPath,
    anchors,
    proposedFiles,
    suggestedDeny,
    anchorStrength: resolution.strength,
    anchorDefense,
    confidence,
    denyOmitted,
  };
}
