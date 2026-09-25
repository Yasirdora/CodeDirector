/**
 * The TypeScript compiler probe, shared by the baseline (the errors that exist
 * before a run) and the verification ladder (the errors after it).
 *
 * The run is judged on the difference. A project that already has a type
 * error — committed, or left uncommitted by another session — used to fail
 * every lock, whatever the lock touched: eDraft's Swift-only locks failed on
 * a half-written SvelteKit route. Errors are compared without their
 * positions, so a run that shifts a pre-existing error down a few lines has
 * not made it new; a run that changes a type and breaks an untouched caller
 * has, which is why this is a before/after diff and not "errors in the files
 * the run changed".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ProbeResult, runArgvProbe, runShellProbe } from "./probe";
import { PutBack, runIsolated } from "./tree";

export interface TypecheckOptions {
  /** tsc --noEmit timeout (default 120s). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Hears what the probe changed and had put back, if anything. */
  onPutBack?: (putBack: PutBack) => void;
}

export type TypecheckProbe =
  | { kind: "no-tsconfig" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ran"; probe: ProbeResult; how: string };

function localTsc(rootDir: string): string | null {
  const p = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
  return fs.existsSync(p) ? p : null;
}

/** Run `tsc --noEmit` the way the ladder always has: local compiler first, then npx without downloads. */
export function probeTypecheck(rootDir: string, opts: TypecheckOptions = {}): TypecheckProbe {
  if (!fs.existsSync(path.join(rootDir, "tsconfig.json"))) return { kind: "no-tsconfig" };
  const timeout = opts.timeoutMs ?? 120_000;
  const tsc = localTsc(rootDir);
  if (tsc) {
    const probe = runIsolated(
      rootDir,
      () => runArgvProbe(rootDir, [process.execPath, tsc, "--noEmit", "-p", "."], timeout, opts.env),
      opts.onPutBack,
    );
    if (probe.timedOut) return { kind: "unavailable", reason: `tsc --noEmit timed out after ${timeout}ms` };
    if (probe.error || probe.exitCode === null) {
      return { kind: "unavailable", reason: `tsc could not run: ${probe.error ?? "spawn failed"}` };
    }
    return { kind: "ran", probe, how: "node node_modules/typescript/bin/tsc --noEmit -p ." };
  }
  // No local install: probe npx without allowing downloads.
  const probe = runIsolated(rootDir, () => runShellProbe(rootDir, "npx --no-install tsc --noEmit", timeout, opts.env), opts.onPutBack);
  const out = `${probe.stdout}\n${probe.stderr}`;
  if (probe.error || probe.timedOut || /could not determine executable|npm error|not installed|not the tsc command/i.test(out)) {
    return {
      kind: "unavailable",
      reason: "typescript compiler unavailable (no node_modules/typescript; `npx --no-install tsc` found no real compiler)",
    };
  }
  return { kind: "ran", probe, how: "npx --no-install tsc --noEmit" };
}

const LOCATED = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/;
const GLOBAL = /^error (TS\d+): (.*)$/;

/**
 * One key per compiler error — file, code and message, position dropped —
 * with the original line kept for display. Continuation lines are skipped.
 */
export function typecheckErrors(stdout: string): Array<{ key: string; line: string }> {
  const out: Array<{ key: string; line: string }> = [];
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

/** The errors in `after` that `before` does not account for (a multiset difference). */
export function newTypecheckErrors(
  before: string[],
  after: Array<{ key: string; line: string }>,
): Array<{ key: string; line: string }> {
  const left = new Map<string, number>();
  for (const k of before) left.set(k, (left.get(k) ?? 0) + 1);
  const fresh: Array<{ key: string; line: string }> = [];
  for (const e of after) {
    const n = left.get(e.key) ?? 0;
    if (n > 0) left.set(e.key, n - 1);
    else fresh.push(e);
  }
  return fresh;
}
