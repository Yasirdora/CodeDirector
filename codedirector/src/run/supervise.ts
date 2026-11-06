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
import * as path from "node:path";
import { spawn } from "node:child_process";
import { clock, formatDuration, STEP_DIR_ENV } from "../verify/steps";

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
  /**
   * Set when the command runs as named checks (verify/steps.ts): the folder
   * its markers go to, handed to the shell as CDIR_STEP_DIR, and the checks'
   * names. With `progress`, a line goes to file descriptor 3 each time a
   * check starts — the caller's stderr, so a person can watch a long run.
   */
  steps?: { dir: string; names: string[]; progress?: boolean };
}

export interface SuperviseResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when the command could not be started. */
  spawnError?: string;
  /** When the command's process ended (ms since the epoch). */
  endedAtMs?: number;
}

function main(specPath: string): void {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as SuperviseSpec;
  const out = fs.openSync(spec.stdoutPath, "w");
  const err = fs.openSync(spec.stderrPath, "w");
  const posix = process.platform !== "win32";
  const options = {
    cwd: spec.cwd,
    stdio: ["ignore", out, err] as ["ignore", number, number],
    detached: posix,
    ...(spec.steps ? { env: { ...process.env, [STEP_DIR_ENV]: spec.steps.dir } } : {}),
  };
  const child = spec.shell !== undefined
    ? spawn(spec.shell, { ...options, shell: true })
    : spawn(spec.argv![0], spec.argv!.slice(1), options);

  let timedOut = false;
  let done = false;
  const stopWatching = spec.steps?.progress ? watchSteps(spec.steps) : () => {};
  const finish = (result: SuperviseResult): void => {
    if (done) return;
    done = true;
    stopWatching();
    fs.writeFileSync(spec.resultPath, JSON.stringify({ ...result, endedAtMs: result.endedAtMs ?? Date.now() }));
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
    finish({ exitCode: exited.code, signal: exited.signal, timedOut, endedAtMs });
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
  let endedAtMs: number | undefined;
  child.on("exit", (code, signal) => {
    endedAtMs = Date.now();
    exited = { code, signal };
    if (!timedOut) clearTimeout(timer);
    settle();
  });
}

/** How often the marker folder is read for progress. */
const PROGRESS_POLL_MS = 500;

/**
 * Says on file descriptor 3 when each check starts, with the time the one
 * before it took. Read from the markers, so it says what the shell did, not
 * what we expected; a descriptor that is not open costs nothing and says
 * nothing. Returns the function that stops the watch.
 */
function watchSteps(steps: NonNullable<SuperviseSpec["steps"]>): () => void {
  const total = steps.names.length;
  let next = 0;
  let previousStart: number | undefined;
  let open = true;
  const say = (line: string): void => {
    if (!open) return;
    try {
      fs.writeSync(3, `${line}\n`);
    } catch {
      open = false; // nobody is listening
    }
  };
  const look = (): void => {
    while (next < total) {
      let started: number;
      try {
        started = fs.statSync(path.join(steps.dir, String(next))).mtimeMs;
      } catch {
        return; // not started yet
      }
      const before = previousStart !== undefined ? ` (${steps.names[next - 1]} took ${formatDuration(started - previousStart)})` : "";
      say(`cdir · ${clock(started)} · check ${next + 1}/${total} ${steps.names[next]} started${before}`);
      previousStart = started;
      next++;
    }
  };
  const timer = setInterval(look, PROGRESS_POLL_MS);
  return () => {
    clearInterval(timer);
    look();
  };
}

if (require.main === module) main(process.argv[2]);
