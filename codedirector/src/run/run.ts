/**
 * `cdir run <lock-id> -- <command...>` — the verified-execution wrapper.
 *
 * Loop (blueprint §16, descoped to Stage 2):
 *   1. Load the ACTIVE Lock (drafts must be activated first).
 *   2. Checkpoint (git tag) before anything.
 *   3. Refresh the index; capture the KEEP baseline (signatures, manifests,
 *      git status) to .codedirector/baselines/ — outside the source tree.
 *   4. Execute the command with inherited stdio.
 *   5. Classify every changed file against the Lock; diff the baseline.
 *      Denied / out-of-budget changes are violations (unless --allow-expand,
 *      a logged override). Nothing is auto-reverted — the human decides.
 *   6. Write the run record to .codedirector/runs/.
 *
 * Exit code: 0 only if the command succeeded AND no violations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { RepoIndex } from "../core/types";
import { buildIndex, hashContent } from "../core/builder";
import { buildGraph } from "../core/graph";
import { indexDir, stableStringify } from "../core/store";
import { createCheckpoint, Checkpoint } from "../checkpoint";
import { IntentLock } from "../lock/types";
import { loadLock } from "../lock/store";
import { signatureHash } from "../lock/check";
import { Baseline, captureBaseline, saveBaseline } from "./baseline";
import { changedFiles, changedLineCount, ClassifiedChange, classifyChanges } from "./classify";

export interface KeepResult {
  kind: string;
  detail: string;
  /** ok = verified held · violated = proven broken · deferred = Stage 3 · custom = human judges */
  status: "ok" | "violated" | "deferred" | "custom";
}

export interface BudgetStats {
  filesChanged: number;
  maxFiles: number;
  linesChanged: number;
  maxLines: number;
}

export interface RunRecord {
  lockId: string;
  command: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  checkpoint: Checkpoint;
  baselinePath: string;
  changed: ClassifiedChange[];
  budget: BudgetStats;
  keepResults: KeepResult[];
  violations: string[];
  /** True when --allow-expand downgraded scope violations to logged overrides. */
  allowExpand: boolean;
}

export class RunError extends Error {}

export function runsDir(rootDir: string): string {
  return path.join(indexDir(rootDir), "runs");
}

export interface RunOptions {
  allowExpand?: boolean;
  /** stdio for the child command (default "inherit"; tests may use "pipe"). */
  stdio?: "inherit" | "pipe";
}

export interface RunOutcome {
  record: RunRecord;
  recordPath: string;
  /** Process exit code: 0 only when command succeeded and no violations. */
  exitCode: number;
}

function checkKeepClauses(
  rootDir: string,
  lock: IntentLock,
  baseline: Baseline,
  indexAfter: RepoIndex,
): KeepResult[] {
  const results: KeepResult[] = [];
  const graphAfter = buildGraph(indexAfter);
  for (const clause of lock.keep) {
    switch (clause.kind) {
      case "api-unchanged": {
        for (const id of clause.symbols ?? []) {
          const before = baseline.signatures[id];
          const sym = graphAfter.symbols.get(id);
          if (before === undefined) continue; // not captured (did not resolve pre-run)
          if (!sym) {
            results.push({ kind: clause.kind, detail: `${id} no longer exists`, status: "violated" });
          } else if (signatureHash(sym.signature) !== before) {
            results.push({ kind: clause.kind, detail: `signature changed: ${id}`, status: "violated" });
          } else {
            results.push({ kind: clause.kind, detail: `signature unchanged: ${id}`, status: "ok" });
          }
        }
        break;
      }
      case "no-new-dependency": {
        for (const [m, before] of Object.entries(baseline.manifests)) {
          const p = path.join(rootDir, m);
          if (!fs.existsSync(p)) {
            results.push({ kind: clause.kind, detail: `${m} deleted`, status: "violated" });
            continue;
          }
          const after = hashContent(fs.readFileSync(p, "utf8"));
          results.push(
            after === before
              ? { kind: clause.kind, detail: `${m} unchanged`, status: "ok" }
              : { kind: clause.kind, detail: `${m} changed`, status: "violated" },
          );
        }
        // a manifest that did not exist before but exists now is a new dependency surface
        for (const m of ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]) {
          if (!(m in baseline.manifests) && fs.existsSync(path.join(rootDir, m))) {
            results.push({ kind: clause.kind, detail: `${m} appeared`, status: "violated" });
          }
        }
        break;
      }
      case "output-unchanged":
        results.push({
          kind: clause.kind,
          detail: `${clause.command ?? "(no command)"} — stored; executed by the Stage 3 runner`,
          status: "deferred",
        });
        break;
      case "tests-pass":
        results.push({
          kind: clause.kind,
          detail: `${clause.glob ?? "(no glob)"} — stored; executed by the Stage 3 runner`,
          status: "deferred",
        });
        break;
      case "custom":
        results.push({
          kind: clause.kind,
          detail: `${clause.text ?? ""} — not machine-checkable; human judges`,
          status: "custom",
        });
        break;
    }
  }
  return results;
}

export async function runWithLock(
  rootDir: string,
  lockId: string,
  command: string[],
  opts: RunOptions = {},
): Promise<RunOutcome> {
  if (command.length === 0) throw new RunError("no command given — usage: cdir run <lock-id> -- <command...>");

  const lock = loadLock(rootDir, lockId);
  if (!lock) throw new RunError(`no such lock: ${lockId} (see \`cdir lock ls\`)`);
  if (lock.status === "draft") {
    throw new RunError(`lock ${lockId} is a draft — review it and run \`cdir lock activate ${lockId}\` first`);
  }
  if (lock.status !== "active") {
    throw new RunError(`lock ${lockId} has status "${lock.status}" — only active locks can run`);
  }

  // 1. checkpoint before anything
  const checkpoint = createCheckpoint(rootDir);

  // 2. refresh index + capture baseline (outside the source tree)
  const { index: indexBefore } = await buildIndex(rootDir);
  const baseline: Baseline = captureBaseline(rootDir, lock, indexBefore, checkpoint.tag);
  const baselinePath = saveBaseline(rootDir, baseline);

  // 3. execute
  const startedAt = new Date().toISOString();
  const child = spawnSync(command[0], command.slice(1), {
    cwd: rootDir,
    stdio: opts.stdio ?? "inherit",
    shell: false,
  });
  const finishedAt = new Date().toISOString();
  const commandExit = child.error ? 127 : (child.status ?? 1);

  // 4. classify changes against the Lock
  const changed = classifyChanges(rootDir, lock);
  const untracked = changedFiles(rootDir)
    .filter((c) => c.status === "??")
    .map((c) => c.path);
  const linesChanged = changedLineCount(rootDir, untracked);
  const budget: BudgetStats = {
    filesChanged: changed.length,
    maxFiles: lock.budget.maxFiles,
    linesChanged,
    maxLines: lock.budget.maxLines,
  };

  // 5. KEEP checks against the baseline
  const { index: indexAfter } = await buildIndex(rootDir);
  const keepResults = checkKeepClauses(rootDir, lock, baseline, indexAfter);

  const scopeViolations: string[] = [];
  for (const c of changed) {
    if (c.class === "denied") {
      scopeViolations.push(`DENY: ${c.path} matches deny pattern "${c.matchedDeny}"`);
    } else if (c.class === "out-of-budget") {
      scopeViolations.push(`OUT-OF-BUDGET: ${c.path} is not in budget.files`);
    }
  }
  if (budget.filesChanged > budget.maxFiles) {
    scopeViolations.push(`BUDGET: ${budget.filesChanged} files changed > maxFiles ${budget.maxFiles}`);
  }
  if (budget.linesChanged > budget.maxLines) {
    scopeViolations.push(`BUDGET: ${budget.linesChanged} lines changed > maxLines ${budget.maxLines}`);
  }
  const keepViolations = keepResults
    .filter((r) => r.status === "violated")
    .map((r) => `KEEP ${r.kind}: ${r.detail}`);

  const allowExpand = opts.allowExpand === true;
  // --allow-expand is the logged override for SCOPE growth only; a broken
  // KEEP clause is never overridden (the rule that gives the Lock teeth).
  const violations = allowExpand ? keepViolations : [...scopeViolations, ...keepViolations];

  const record: RunRecord = {
    lockId: lock.id,
    command,
    startedAt,
    finishedAt,
    exitCode: commandExit,
    checkpoint,
    baselinePath: path.relative(rootDir, baselinePath),
    changed,
    budget,
    keepResults,
    violations,
    allowExpand,
  };
  fs.mkdirSync(runsDir(rootDir), { recursive: true });
  const ts = startedAt.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const recordPath = path.join(runsDir(rootDir), `${lock.id}-${ts}.json`);
  fs.writeFileSync(recordPath, stableStringify(record), "utf8");

  const exitCode = commandExit === 0 && violations.length === 0 ? 0 : 1;
  return { record, recordPath, exitCode };
}

/** Human-readable violation report printed after a failed run. */
export function formatRunReport(outcome: RunOutcome): string {
  const r = outcome.record;
  const lines: string[] = [];
  lines.push(
    `run ${r.lockId} · command exited ${r.exitCode} · ` +
      `${r.changed.length} file(s) changed (${r.budget.filesChanged}/${r.budget.maxFiles} files, ` +
      `${r.budget.linesChanged}/${r.budget.maxLines} lines)`,
  );
  lines.push(`checkpoint: ${r.checkpoint.tag} — restore with \`cdir undo\``);
  lines.push(`record: ${outcome.recordPath}`);
  if (r.keepResults.length > 0) {
    lines.push(`KEEP:`);
    for (const k of r.keepResults) {
      const mark = k.status === "ok" ? "✓" : k.status === "violated" ? "✗" : k.status === "deferred" ? "~" : "?";
      lines.push(`  ${mark} ${k.kind}: ${k.detail}`);
    }
  }
  if (r.changed.length > 0) {
    lines.push(`changed files:`);
    for (const c of r.changed) {
      const tag =
        c.class === "denied" ? "DENIED" : c.class === "out-of-budget" ? "OUT-OF-BUDGET" : "in-budget";
      lines.push(`  ${c.path}  [${tag}]`);
    }
  }
  if (r.violations.length > 0) {
    lines.push(``, `VIOLATIONS (${r.violations.length}):`);
    for (const v of r.violations) lines.push(`  ✗ ${v}`);
    lines.push(
      ``,
      `Nothing was reverted automatically — you decide:`,
      `  cdir undo            restore the checkpoint (${r.checkpoint.tag})`,
      `  cdir run ${r.lockId} --allow-expand -- ...   re-run accepting the expanded scope (logged override)`,
    );
  } else if (r.allowExpand) {
    lines.push(``, `note: --allow-expand was passed; out-of-budget scope was accepted (logged override).`);
  }
  return lines.join("\n");
}
