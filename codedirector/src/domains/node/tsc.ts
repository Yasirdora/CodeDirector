/**
 * The TypeScript compiler check, described for the core to run.
 *
 * The core runs it for the baseline (the errors that exist before a run) and
 * for the verification ladder (the errors after it), and judges the run on
 * the difference (run/diagnostics.ts). A project that already has a type
 * error — committed, or left uncommitted by another session — used to fail
 * every lock, whatever the lock touched: eDraft's Swift-only locks failed on
 * a half-written SvelteKit route. Errors are keyed without their positions,
 * so a run that shifts a pre-existing error down a few lines has not made it
 * new; a run that changes a type and breaks an untouched caller has, which
 * is why this is a before/after diff and not "errors in the files the run
 * changed".
 *
 * What lives here is what is true of tsc: when it applies (a tsconfig.json),
 * where to find it (the project's own install first, then npx without
 * downloads), and how to read its output.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic, DiagnosticsCheck, DiagnosticsPlan } from "../../domain/types";

function localTsc(rootDir: string): string | null {
  const p = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
  return fs.existsSync(p) ? p : null;
}

function planTsc(rootDir: string): DiagnosticsPlan {
  if (!fs.existsSync(path.join(rootDir, "tsconfig.json"))) {
    return { kind: "not-applicable", reason: "no tsconfig.json — typecheck rung skipped" };
  }
  const tsc = localTsc(rootDir);
  if (tsc) {
    return {
      kind: "run",
      run: { argv: [process.execPath, tsc, "--noEmit", "-p", "."] },
      how: "node node_modules/typescript/bin/tsc --noEmit -p .",
    };
  }
  // No local install: probe npx without allowing downloads.
  return {
    kind: "run",
    run: { shell: "npx --no-install tsc --noEmit" },
    how: "npx --no-install tsc --noEmit",
    unavailableReason:
      "typescript compiler unavailable (no node_modules/typescript; `npx --no-install tsc` found no real compiler)",
    unavailableOutput: /could not determine executable|npm error|not installed|not the tsc command/i,
  };
}

const LOCATED = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;
const GLOBAL = /^error (TS\d+): (.*)$/;

/**
 * One key per compiler error — file, code and message, position dropped —
 * with the original line kept for display. Continuation lines are skipped.
 */
export function typecheckErrors(stdout: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    const located = LOCATED.exec(line);
    if (located) {
      out.push({ key: `${located[1]}: ${located[2]}: ${located[3]}`, line });
      continue;
    }
    const global = GLOBAL.exec(line);
    if (global) out.push({ key: `(project): ${global[1]}: ${global[2]}`, line });
  }
  return out;
}

export const tscCheck: DiagnosticsCheck = {
  id: "node.tsc",
  subject: "typecheck · tsc --noEmit",
  label: "tsc --noEmit",
  tool: "tsc",
  defaultTimeoutMs: 120_000,
  plan: planTsc,
  parse: typecheckErrors,
  isErrorLine: (line) => line.includes("error TS"),
  legacyBaselineField: "typecheckErrors",
};
