/**
 * Read-only command probe: runs a shell command with a bounded timeout and
 * captures stdout/stderr, never writing anything to the repository itself.
 *
 * Used for KEEP-surface probes (output-unchanged baselines, test runs,
 * typechecks). "Read-only" is by construction on OUR side — this module
 * performs no writes — but the probed command itself runs with the repo's
 * permissions. A fully sandboxed verifier (no write access for the probed
 * process) is a later phase, per the blueprint.
 */

import { spawnSync } from "node:child_process";
import { hashContent } from "../core/builder";

export interface ProbeResult {
  /** Shell command as executed. */
  command: string;
  /** Process exit code; null when the process could not be spawned. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command timed out. */
  timedOut: boolean;
  /** Set when the command could not be run at all (spawn error). */
  error?: string;
}

export function runShellProbe(
  rootDir: string,
  command: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): ProbeResult {
  const child = spawnSync(command, {
    cwd: rootDir,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut = child.error !== undefined && (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const spawnError =
    child.error !== undefined && !timedOut
      ? child.error.message
      : child.status === null && child.signal
        ? `killed by signal ${child.signal}`
        : undefined;
  return {
    command,
    exitCode: child.status,
    stdout: typeof child.stdout === "string" ? child.stdout : "",
    stderr: typeof child.stderr === "string" ? child.stderr : "",
    timedOut: timedOut || (child.signal === "SIGTERM" && child.status === null),
    error: spawnError,
  };
}

/** Same as runShellProbe but for an explicit argv (no shell). */
export function runArgvProbe(
  rootDir: string,
  argv: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): ProbeResult {
  const child = spawnSync(argv[0], argv.slice(1), {
    cwd: rootDir,
    shell: false,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timedOut = child.error !== undefined && (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const spawnError =
    child.error !== undefined && !timedOut
      ? child.error.message
      : child.status === null && child.signal
        ? `killed by signal ${child.signal}`
        : undefined;
  return {
    command: argv.join(" "),
    exitCode: child.status,
    stdout: typeof child.stdout === "string" ? child.stdout : "",
    stderr: typeof child.stderr === "string" ? child.stderr : "",
    timedOut: timedOut || (child.signal === "SIGTERM" && child.status === null),
    error: spawnError,
  };
}

/** sha256 of a string — the output-unchanged evidence primitive. */
export function sha256(text: string): string {
  return hashContent(text);
}
