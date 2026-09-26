/**
 * Read-only command probe: runs a shell command with a bounded timeout and
 * captures stdout/stderr, never writing anything to the repository itself.
 * Each command runs under a supervisor process (run/supervise.ts) that owns
 * its process group and its output files.
 *
 * Used for KEEP-surface probes (output-unchanged baselines, test runs,
 * typechecks). "Read-only" is by construction on OUR side — this module
 * performs no writes — but the probed command itself runs with the repo's
 * permissions. A fully sandboxed verifier (no write access for the probed
 * process) is a later phase, per the blueprint.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { hashContent } from "../core/builder";
import type { SuperviseResult, SuperviseSpec } from "./supervise";

export interface ProbeResult {
  /** Shell command as executed. */
  command: string;
  /** Process exit code; null when the process could not be spawned. */
  exitCode: number | null;
  /**
   * The command's output, whole up to MAX_CAPTURED_BYTES per stream. Past
   * that, the END is kept — where compilers and test runners put their
   * errors and summaries — behind a line saying how much was left out.
   */
  stdout: string;
  stderr: string;
  /** sha256 of the complete stdout / stderr, however long (sha256(stdout) when nothing was cut). */
  stdoutSha256: string;
  stderrSha256: string;
  /** Bytes left out of stdout / stderr, when any were. */
  omitted?: { stdout?: number; stderr?: number };
  /** Set when the command timed out. */
  timedOut: boolean;
  /** Set when the command could not be run at all (spawn error). */
  error?: string;
}

/** Output kept in memory per stream; the rest is hashed, not held. */
export const MAX_CAPTURED_BYTES = 16 * 1024 * 1024;

/** Between stopping a timed-out command politely (SIGTERM) and by force (SIGKILL). */
export const KILL_GRACE_MS = 3000;

/**
 * Environment for probes: the inherited environment minus test-runner
 * context markers. Without this, `node --test` spawned from inside another
 * `node --test` process (e.g. `cdir run` invoked by an npm test script)
 * silently refuses to run and exits 0 — a false "held". Stripping the marker
 * makes the nested run real.
 */
function probeEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...(env ?? process.env) };
  delete out.NODE_TEST_CONTEXT;
  return out;
}

/** A stream's text (its tail past the cap) and the hash of all of it. */
function readStream(file: string): { text: string; sha256: string; omitted: number } {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { text: "", sha256: hashContent(""), omitted: 0 };
  }
  if (size <= MAX_CAPTURED_BYTES) {
    // Identical to hashing the string, as every earlier baseline did.
    const text = fs.readFileSync(file, "utf8");
    return { text, sha256: hashContent(text), omitted: 0 };
  }
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let read: number;
    let pos = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, pos)) > 0) {
      hash.update(chunk.subarray(0, read));
      pos += read;
    }
    const tail = Buffer.alloc(MAX_CAPTURED_BYTES);
    const omitted = size - MAX_CAPTURED_BYTES;
    fs.readSync(fd, tail, 0, MAX_CAPTURED_BYTES, omitted);
    const text = `[cdir: the first ${omitted} bytes of this output were left out; the end is kept]\n${tail.toString("utf8")}`;
    return { text, sha256: hash.digest("hex"), omitted };
  } finally {
    fs.closeSync(fd);
  }
}

const SUPERVISOR = path.join(__dirname, "supervise.js");

/**
 * Run one command under the supervisor (run/supervise.ts): its own process
 * group, output to files, the whole group stopped on timeout. Synchronous,
 * like every caller.
 */
function runSupervised(
  rootDir: string,
  command: { argv: string[] } | { shell: string },
  label: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): ProbeResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-probe-"));
  try {
    const spec: SuperviseSpec = {
      cwd: rootDir,
      ...command,
      timeoutMs,
      graceMs: KILL_GRACE_MS,
      stdoutPath: path.join(dir, "stdout"),
      stderrPath: path.join(dir, "stderr"),
      resultPath: path.join(dir, "result.json"),
    };
    const specPath = path.join(dir, "spec.json");
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const sup = spawnSync(process.execPath, [SUPERVISOR, specPath], {
      env: probeEnv(env),
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
      // A backstop only: the supervisor enforces the real timeout.
      timeout: timeoutMs + KILL_GRACE_MS + 30_000,
    });
    let result: SuperviseResult;
    try {
      result = JSON.parse(fs.readFileSync(spec.resultPath, "utf8")) as SuperviseResult;
    } catch {
      const why = sup.error?.message ?? (sup.stderr || `supervisor exited ${sup.status ?? sup.signal}`);
      return {
        command: label,
        exitCode: null,
        stdout: "",
        stderr: "",
        stdoutSha256: hashContent(""),
        stderrSha256: hashContent(""),
        timedOut: false,
        error: `probe supervisor failed: ${String(why).trim().slice(0, 300)}`,
      };
    }
    const out = readStream(spec.stdoutPath);
    const err = readStream(spec.stderrPath);
    const omitted = {
      ...(out.omitted > 0 ? { stdout: out.omitted } : {}),
      ...(err.omitted > 0 ? { stderr: err.omitted } : {}),
    };
    return {
      command: label,
      exitCode: result.exitCode,
      stdout: out.text,
      stderr: err.text,
      stdoutSha256: out.sha256,
      stderrSha256: err.sha256,
      ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
      timedOut: result.timedOut,
      error:
        result.spawnError ??
        (result.exitCode === null && result.signal ? `killed by signal ${result.signal}` : undefined),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function runShellProbe(
  rootDir: string,
  command: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): ProbeResult {
  return runSupervised(rootDir, { shell: command }, command, timeoutMs, env);
}

/** Same as runShellProbe but for an explicit argv (no shell). */
export function runArgvProbe(
  rootDir: string,
  argv: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): ProbeResult {
  return runSupervised(rootDir, { argv }, argv.join(" "), timeoutMs, env);
}

/** sha256 of a string — the output-unchanged evidence primitive. */
export function sha256(text: string): string {
  return hashContent(text);
}
