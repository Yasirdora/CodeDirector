/**
 * measure.ts — mechanical metrics for one benchmark run.
 * Nothing here uses a model; these are the numbers the report can stand on.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(exec);

const GS = ""; // placeholder for globstar
const SS = ""; // placeholder for single star

/** Minimal glob: supports `*` (within a segment), `**` (any depth), and exact paths. */
export function matchPath(glob: string, rel: string): boolean {
  let re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*\*\//g, GS + "/"); // **/ = any leading depth, optional
  re = re.replace(/\*\*/g, GS); // remaining ** = anything
  re = re.replace(/\*/g, SS); // * = within a segment
  re = re
    .split(GS + "/").join("(?:.*/)?")
    .split(GS).join(".*")
    .split(SS).join("[^/]*");
  try {
    return new RegExp(`^${re}$`).test(rel);
  } catch {
    return glob === rel;
  }
}

/** Test-helper files never count as unintended changes. */
export function isTestHelper(rel: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(rel) || /\.(test|spec)\.[tj]sx?$/.test(rel);
}

/**
 * Files changed outside must_change ∪ test-helpers.
 * must_change entries are exact paths or globs.
 */
export function unintendedChanges(changedFiles: string[], mustChange: string[]): string[] {
  return changedFiles.filter(
    (f) => !isTestHelper(f) && !mustChange.some((g) => matchPath(g, f)),
  );
}

export interface CheckResult {
  command: string;
  exitCode: number;
  outputTail: string;
}

export async function runChecks(workdir: string, checks: string[]): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const command of checks) {
    try {
      const { stdout, stderr } = await execP(command, {
        cwd: workdir,
        timeout: 60_000,
        env: { ...process.env, CI: "1" },
      });
      out.push({ command, exitCode: 0, outputTail: (stdout + stderr).slice(-400) });
    } catch (err: unknown) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      out.push({
        command,
        exitCode: typeof e.code === "number" ? e.code : 1,
        outputTail: ((e.stdout ?? "") + (e.stderr ?? "") + (e.code === undefined ? e.message ?? "" : "")).slice(-400),
      });
    }
  }
  return out;
}

export function checksPass(results: CheckResult[]): boolean {
  return results.length > 0 && results.every((r) => r.exitCode === 0);
}

/** Mechanical proxy for intent accuracy — never rests on the LLM judge. */
export function mechanicalProxy(checks: CheckResult[], unintended: string[]): boolean {
  return checksPass(checks) && unintended.length === 0;
}
