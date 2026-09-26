/**
 * The probe supervisor: a small process that runs one check command and
 * owns its lifetime (run/probe.ts starts it; nothing else does).
 *
 * Why a separate process: the verifier is synchronous, and Node's
 * synchronous spawn can only signal the process it started. A shell and
 * everything it launched — a compiler, a test runner, xcodebuild's workers —
 * survived a timeout and kept running (reproduced: three `sleep`s left
 * behind), holding locks the next build needs. And its output was held in
 * memory with a 16 MB ceiling: past it the check failed as "could not run"
 * and the diagnostic that mattered was lost.
 *
 * So this process:
 *  - starts the command as the leader of its own process group, writing its
 *    output straight to files (no ceiling, nothing held in memory);
 *  - on timeout, stops the whole group: SIGTERM, then SIGKILL after a grace
 *    period for whatever ignored it;
 *  - writes what happened to a result file and exits.
 *
 * A command that finishes on its own is left to do so: anything it leaves
 * running on purpose (a build daemon) is its business, not a timeout's.
 */

import * as fs from "node:fs";
import { spawn } from "node:child_process";

export interface SuperviseSpec {
  cwd: string;
  /** Exactly one of argv and shell. */
  argv?: string[];
  shell?: string;
  timeoutMs: number;
  /** Between SIGTERM and SIGKILL of the group. */
  graceMs: number;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
}

export interface SuperviseResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when the command could not be started. */
  spawnError?: string;
}

function main(specPath: string): void {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as SuperviseSpec;
  const out = fs.openSync(spec.stdoutPath, "w");
  const err = fs.openSync(spec.stderrPath, "w");
  const posix = process.platform !== "win32";
  const options = { cwd: spec.cwd, stdio: ["ignore", out, err] as ["ignore", number, number], detached: posix };
  const child = spec.shell !== undefined
    ? spawn(spec.shell, { ...options, shell: true })
    : spawn(spec.argv![0], spec.argv!.slice(1), options);

  let timedOut = false;
  let done = false;
  const finish = (result: SuperviseResult): void => {
    if (done) return;
    done = true;
    fs.writeFileSync(spec.resultPath, JSON.stringify(result));
    process.exit(0);
  };
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      // The negative pid is the process group: the command and everything it started.
      if (posix) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // already gone
    }
  };

  let exited: { code: number | null; signal: string | null } | null = null;
  let killed = false;
  const settle = (): void => {
    if (!exited) return;
    if (timedOut && !killed) return; // the group is still being stopped
    finish({ exitCode: exited.code, signal: exited.signal, timedOut });
  };

  /** Whether any process of the group is still alive (signal 0 only checks). */
  const groupAlive = (): boolean => {
    if (child.pid === undefined || !posix) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup("SIGTERM");
    // Done as soon as the group is gone; SIGKILL whatever outlives the grace.
    const deadline = Date.now() + spec.graceMs;
    const poll = setInterval(() => {
      if (groupAlive() && Date.now() < deadline) return;
      clearInterval(poll);
      if (groupAlive()) signalGroup("SIGKILL");
      killed = true;
      settle();
    }, 50);
  }, spec.timeoutMs);

  child.on("error", (e) => {
    clearTimeout(timer);
    finish({ exitCode: null, signal: null, timedOut: false, spawnError: e.message });
  });
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    if (!timedOut) clearTimeout(timer);
    settle();
  });
}

if (require.main === module) main(process.argv[2]);
