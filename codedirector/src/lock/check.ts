/**
 * Lock validation: `cdir lock check <id>`.
 *
 * Checks everything that can be checked without executing anything:
 * budget files exist, budget/api-unchanged symbols resolve in the current
 * index, deny globs are valid, custom clauses carry the "human judges"
 * warning, and budget.maxFiles >= budget.files.length.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { RepoIndex } from "../core/types";
import { buildGraph } from "../core/graph";
import { VibeCheck, KeepClause, clauseCheckability } from "./types";
import { validateGlob } from "./glob";
// `languageOf` lives in draft.ts because IL-0001 needed it there first.
// A fundamental module importing from the drafter is the wrong direction and
// the table belongs in a shared file; duplicating it here would be worse, so
// it is imported and the relocation left as its own change.
import { languageOf } from "./draft";

/**
 * What a toolchain named in a verify command actually exercises.
 *
 * Read from the command's text, which is all there is to read: a command is
 * a string, not a manifest. The list is deliberately conservative — a
 * toolchain absent from it produces a warning, never a refusal, because
 * refusing every bespoke harness would be a worse failure than the one this
 * exists to prevent.
 */
const TOOLCHAIN_REACH: Array<{ name: string; pattern: RegExp; languages: string[] }> = [
  { name: "swift", pattern: /\bswift\s+(test|build|run)\b/, languages: ["Swift"] },
  {
    name: "xcodebuild",
    pattern: /\bxcodebuild\b/,
    languages: ["Swift", "Objective-C", "Objective-C++"],
  },
  { name: "tsc", pattern: /\btsc\b/, languages: ["TypeScript"] },
  { name: "node --test", pattern: /\bnode\s+--test\b/, languages: ["TypeScript", "JavaScript"] },
  { name: "npm/yarn/pnpm", pattern: /\b(npm|yarn|pnpm)\b/, languages: ["TypeScript", "JavaScript"] },
  {
    name: "vitest/jest/mocha",
    pattern: /\b(vitest|jest|mocha)\b/,
    languages: ["TypeScript", "JavaScript"],
  },
  { name: "pytest", pattern: /\bpytest\b/, languages: ["Python"] },
  { name: "go", pattern: /\bgo\s+(test|build|vet)\b/, languages: ["Go"] },
  { name: "cargo", pattern: /\bcargo\s+(test|build|check|clippy)\b/, languages: ["Rust"] },
  { name: "gradle/maven", pattern: /\b(gradlew?|mvn)\b/, languages: ["Java", "Kotlin"] },
];

export interface VerifyCoverage {
  /** Languages the budget touches. Files naming none are not counted. */
  budgetLanguages: string[];
  /** Toolchains recognised in the command, by the names above. */
  toolchains: string[];
  /** Budget languages nothing in the command — or verifyCovers — reaches. */
  missing: string[];
}

/**
 * Whether a lock's verifyCommand can plausibly exercise what its budget
 * touches.
 *
 * Files whose extension names no language — .md, .gitignore, .json — are
 * ignored rather than counted as uncoverable. A documentation lock has
 * nothing for a test command to exercise, and refusing it for that would be
 * the opposite of useful. A budget entry that is a glob likewise names no
 * language, so its coverage is not judged; that is a known blind spot.
 */
export function verifyCoverage(lock: VibeCheck): VerifyCoverage {
  const budgetLanguages = [
    ...new Set(lock.budget.files.map(languageOf).filter((l) => l !== "other")),
  ].sort();
  const command = lock.verifyCommand ?? "";
  const recognised = TOOLCHAIN_REACH.filter((t) => t.pattern.test(command));
  const reached = new Set<string>(lock.verifyCovers ?? []);
  for (const t of recognised) for (const l of t.languages) reached.add(l);
  return {
    budgetLanguages,
    toolchains: recognised.map((t) => t.name),
    missing: budgetLanguages.filter((l) => !reached.has(l)),
  };
}

/** sha256 of a symbol signature — the api-unchanged evidence primitive. */
export function signatureHash(signature: string): string {
  return createHash("sha256").update(signature, "utf8").digest("hex");
}

export interface ClauseCheck {
  clause: KeepClause;
  checkability: "now" | "deferred" | "custom";
  /** Errors found for this clause (empty when the clause is well-formed). */
  errors: string[];
  note: string;
}

export interface LockCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  clauses: ClauseCheck[];
}

function checkClause(clause: KeepClause, index: RepoIndex | null): ClauseCheck {
  const checkability = clauseCheckability(clause);
  const errors: string[] = [];
  let note = "";
  switch (clause.kind) {
    case "api-unchanged": {
      if (!clause.symbols || clause.symbols.length === 0) {
        errors.push(`api-unchanged clause has no symbols`);
        break;
      }
      if (index) {
        const graph = buildGraph(index);
        for (const id of clause.symbols) {
          if (!graph.symbols.has(id)) errors.push(`symbol not in index: ${id}`);
        }
        note = errors.length === 0 ? "signature-hash checkable now" : "";
      } else {
        note = "index unavailable — symbols not resolved";
      }
      break;
    }
    case "output-unchanged":
      if (!clause.command) errors.push("output-unchanged clause has no command");
      note = "differential stdout hash — captured at baseline, re-run by the verifier";
      break;
    case "no-new-dependency":
      note = "manifest/lockfile diff — checkable against a captured baseline";
      break;
    case "tests-pass":
      if (!clause.glob) {
        errors.push("tests-pass clause has no glob");
      } else {
        const g = validateGlob(clause.glob);
        if (g) errors.push(`tests-pass glob invalid: ${g}`);
      }
      if (errors.length === 0) note = "executed by the verifier via `node --test`";
      break;
    case "custom":
      if (!clause.text) errors.push("custom clause has no text");
      note = "not machine-checkable — human judges";
      break;
  }
  return { clause, checkability, errors, note };
}

/**
 * Why a budget path can never be right, or null when it might be.
 *
 * The distinction this file can actually draw. Whether a missing file is a
 * typo or a file about to be written is not knowable here — but an absolute
 * path, or one that climbs out of the repository, is wrong under every
 * reading: a Lock scoped to this root cannot create it, and run_locked would
 * never classify it as in-budget.
 */
function budgetPathProblem(rootDir: string, relPath: string): string | null {
  if (path.isAbsolute(relPath)) {
    return "is an absolute path; budget files are relative to the repository root";
  }
  const rel = path.relative(rootDir, path.resolve(rootDir, relPath));
  if (rel.startsWith("..")) return "escapes the repository root";
  return null;
}

export function checkLock(rootDir: string, lock: VibeCheck, index: RepoIndex | null): LockCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Budget paths. A path outside the root can never be right. A path that
  // merely does not exist yet usually means the Lock is about to create it,
  // and check time cannot tell that from a typo — so it says both.
  for (const f of lock.budget.files) {
    const impossible = budgetPathProblem(rootDir, f);
    if (impossible) {
      errors.push(`budget file "${f}" ${impossible}`);
      continue;
    }
    if (fs.existsSync(path.join(rootDir, f))) continue;
    if (/[*?]/.test(f)) {
      warnings.push(`budget file "${f}" is a glob; existence not checked`);
    } else {
      warnings.push(
        `budget file does not exist: ${f} — either this lock will create it, or the path is ` +
          `wrong. run_locked classifies the files the command actually touches, so a wrong ` +
          `path fails there, naming the real one`,
      );
    }
  }

  // budget symbols resolve
  if (index) {
    const graph = buildGraph(index);
    for (const id of lock.budget.symbols) {
      if (!graph.symbols.has(id)) errors.push(`budget symbol not in index: ${id}`);
    }
  } else if (lock.budget.symbols.length > 0) {
    warnings.push("index unavailable — budget symbols not resolved");
  }

  // budget coherence
  if (lock.budget.maxFiles < lock.budget.files.length) {
    errors.push(
      `budget.maxFiles (${lock.budget.maxFiles}) < budget.files.length (${lock.budget.files.length})`,
    );
  }
  if (lock.budget.maxLines <= 0) errors.push("budget.maxLines must be positive");

  // deny globs valid
  for (const d of lock.deny) {
    const g = validateGlob(d);
    if (g) errors.push(`deny pattern "${d}": ${g}`);
  }

  // Verify coverage. A command that cannot exercise the languages the
  // budget touches is not verification of them, and a lock whose budget is
  // entirely Swift must not activate behind a TypeScript-only check. An
  // unreadable command warns instead: see TOOLCHAIN_REACH.
  if (lock.verifyCommand) {
    const coverage = verifyCoverage(lock);
    // Nothing missing is nothing to say. Missing and unreadable is a
    // warning — this cannot be confident, and refusing every bespoke
    // harness would be worse than the hole. Missing and readable is a
    // refusal: the command names a toolchain, and that toolchain does not
    // reach these files.
    if (coverage.missing.length > 0 && coverage.toolchains.length === 0) {
      warnings.push(
        `verifyCommand "${lock.verifyCommand}" names no toolchain this can read, so whether it ` +
          `exercises ${coverage.missing.join(", ")} is unknown — declare it with ` +
          `verifyCovers if it does`,
      );
    } else if (coverage.toolchains.length > 0) {
      for (const language of coverage.missing) {
        const files = lock.budget.files.filter((f) => languageOf(f) === language);
        errors.push(
          `verifyCommand "${lock.verifyCommand}" runs ${coverage.toolchains.join(", ")}, which does ` +
            `not exercise ${language}: ${files.join(", ")} would change unverified. Add a ` +
            `${language} check to verifyCommand, or declare it with verifyCovers: ["${language}"]`,
        );
      }
    }
  }

  // KEEP clauses
  const clauses = lock.keep.map((c) => checkClause(c, index));
  let customCount = 0;
  for (const cc of clauses) {
    errors.push(...cc.errors);
    if (cc.checkability === "custom") {
      customCount++;
      warnings.push(`custom KEEP clause "${cc.clause.text ?? ""}" is not machine-checkable — human judges`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, clauses };
}
