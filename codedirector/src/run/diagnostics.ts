/**
 * Runs a domain's compiler-diagnostics check and compares before with after.
 *
 * Shared by the baseline (the diagnostics that exist before a run) and the
 * verification ladder (the diagnostics after it). The domain says what to
 * run and how to read it (DiagnosticsCheck); this module owns running it —
 * isolated, so whatever the compiler writes is put back, and under a
 * timeout — and the before/after comparison the run is judged on.
 */
import { ProbeResult, runArgvProbe, runShellProbe } from "./probe";
import { PutBack, runIsolated } from "./tree";
import type { Diagnostic, DiagnosticsCheck } from "../domain/types";

export interface DiagnosticsOptions {
  /** Timeout in ms (default: the check's own). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Hears what the probe changed and had put back, if anything. */
  onPutBack?: (putBack: PutBack) => void;
}

export type DiagnosticsProbe =
  | { kind: "not-applicable"; reason: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "ran"; probe: ProbeResult; how: string };

/**
 * The shell's own answer that the command was never run: 127 "command not
 * found", 126 "found but not executable". Not a compiler's verdict on the
 * code — no compiler ran. Reproduced: with no `npx` on the PATH, `npx
 * --no-install tsc` exits 127 ("npx: not found"), and the typecheck was
 * reported as VIOLATED — a false violation, on any machine without npx
 * where the project has a tsconfig.json but no local TypeScript.
 */
const SHELL_COULD_NOT_RUN = new Set([126, 127]);

export function probeDiagnostics(
  rootDir: string,
  check: DiagnosticsCheck,
  opts: DiagnosticsOptions = {},
): DiagnosticsProbe {
  const plan = check.plan(rootDir);
  if (plan.kind === "not-applicable") return plan;
  const timeout = opts.timeoutMs ?? check.defaultTimeoutMs;
  const run = plan.run;
  const probe = runIsolated(
    rootDir,
    () =>
      "argv" in run
        ? runArgvProbe(rootDir, run.argv, timeout, opts.env)
        : runShellProbe(rootDir, run.shell, timeout, opts.env),
    opts.onPutBack,
  );
  const shellCouldNotRun = "shell" in run && probe.exitCode !== null && SHELL_COULD_NOT_RUN.has(probe.exitCode);
  if (plan.unavailableReason !== undefined) {
    const out = `${probe.stdout}\n${probe.stderr}`;
    if (probe.error || probe.timedOut || shellCouldNotRun || plan.unavailableOutput?.test(out)) {
      return { kind: "unavailable", reason: plan.unavailableReason };
    }
    return { kind: "ran", probe, how: plan.how };
  }
  if (shellCouldNotRun) {
    const said = probe.stderr.trim().split("\n").pop() ?? "";
    return { kind: "unavailable", reason: `${check.tool} could not run: exit ${probe.exitCode}${said ? ` (${said.slice(0, 200)})` : ""}` };
  }
  if (probe.timedOut) return { kind: "unavailable", reason: `${check.label} timed out after ${timeout}ms` };
  if (probe.error || probe.exitCode === null) {
    return { kind: "unavailable", reason: `${check.tool} could not run: ${probe.error ?? "spawn failed"}` };
  }
  return { kind: "ran", probe, how: plan.how };
}

/** The diagnostics in `after` that `before` does not account for (a multiset difference). */
export function newDiagnostics(before: string[], after: Diagnostic[]): Diagnostic[] {
  const left = new Map<string, number>();
  for (const k of before) left.set(k, (left.get(k) ?? 0) + 1);
  const fresh: Diagnostic[] = [];
  for (const e of after) {
    const n = left.get(e.key) ?? 0;
    if (n > 0) left.set(e.key, n - 1);
    else fresh.push(e);
  }
  return fresh;
}

/** First error lines from the output (the check's own error lines preferred). */
export function diagnosticsExcerpt(check: DiagnosticsCheck, stdout: string, stderr: string): string {
  const errorLines = stdout.split("\n").filter((l) => check.isErrorLine(l)).slice(0, 5);
  if (errorLines.length > 0) return `: ${errorLines.join(" · ")}`;
  const any = `${stdout}\n${stderr}`.split("\n").filter((l) => l.trim()).slice(0, 3);
  return any.length > 0 ? ` — output: ${any.join(" · ").slice(0, 300)}` : "";
}
