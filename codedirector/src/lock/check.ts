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
import { IntentLock, KeepClause, clauseCheckability } from "./types";
import { validateGlob } from "./glob";

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

export function checkLock(rootDir: string, lock: IntentLock, index: RepoIndex | null): LockCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // budget files exist
  for (const f of lock.budget.files) {
    if (!fs.existsSync(path.join(rootDir, f))) {
      // may be a glob — check whether it matches any indexed/existing file
      if (/[*?]/.test(f)) {
        warnings.push(`budget file "${f}" is a glob; existence not checked`);
      } else {
        errors.push(`budget file does not exist: ${f}`);
      }
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
