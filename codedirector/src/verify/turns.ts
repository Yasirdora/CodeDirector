/**
 * Check runs take turns (`turns` in .codedirector/checks.yaml).
 *
 * Two agents in two worktrees of one machine can start their checks at the
 * same moment. Checks that share a display, a keyboard or a settings file
 * spoil each other, and a verdict from an overlapped run is noise. The rules
 * file names a command prefix that takes a shared turn — a file lock such as
 * `flock FILE` or `lockf -k FILE`; we do not care which. We hold that turn
 * while a lock's verifyCommand runs, so runs that share the rules go one at
 * a time, from any worktree or agent.
 *
 * The turn is held by a holder process, not by us: the prefix wraps a shell
 * that waits until we let go of the turn, or until we are gone. The turn is
 * a real OS lock, so it frees itself if cdir is killed.
 *
 * Only the lock's verifyCommand takes a turn. The other checks of the ladder
 * (tests-pass, output-unchanged, typecheck) run as before.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { containsCommand, loadChecks } from "../config/checks";
import { phaseFor } from "../run/claim";

/** How often we look for the turn; the verifier is synchronous, so we sleep in between. */
const POLL_MS = 200;
/** A wait over this is worth a line in the report. */
const NOTEWORTHY_WAIT_MS = 1000;

/**
 * What the holder runs once it has the turn: it says so by creating READY,
 * then holds on until READY is deleted or its owner (this process) is gone.
 * A holder whose owner died while it queued takes the turn and lets go at once.
 */
const HOLD = [
  'kill -0 "$CDIR_TURN_OWNER" 2>/dev/null || exit 1',
  ': > "$CDIR_TURN_READY"',
  'while [ -e "$CDIR_TURN_READY" ] && kill -0 "$CDIR_TURN_OWNER" 2>/dev/null; do sleep 1; done',
].join("\n");

export interface Turn {
  /** Let go of the turn. The holder is gone within a second. */
  release(): void;
  /** ` (waited 12s for the turn)` when the wait was over a second, else empty. */
  waitNote: string;
}

/** The turn, or the reason a check run cannot be trusted to have had one. */
export type TurnOutcome = { turn: Turn } | { refused: string };

const NO_TURN: Turn = { release: () => {}, waitNote: "" };

const seconds = (ms: number): number => Math.round(ms / 1000);

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Take the turn for `command`, waiting for it as long as the rules allow.
 * With no rules file, no `turns`, or a command that takes the turn itself
 * (taking it twice would wait for ourselves, forever), there is nothing to
 * take. A bad rules file takes no turn either: the run answers for it.
 */
export function takeTurn(rootDir: string, command: string, env?: NodeJS.ProcessEnv): TurnOutcome {
  const file = loadChecks(rootDir);
  if (file.status !== "rules" || !file.rules.turns) return { turn: NO_TURN };
  const { run, waitMs } = file.rules.turns;
  if (containsCommand(command, run)) return { turn: NO_TURN };

  // Said where the wait is, so another process can see why a check is slow.
  phaseFor(rootDir, "waiting for the shared turn");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-turn-"));
  const ready = path.join(dir, "ready");
  const exited = `${ready}.exit`;
  const stderrPath = path.join(dir, "stderr");
  // READY goes with the directory, and the holder sees it gone.
  const release = (): void => fs.rmSync(dir, { recursive: true, force: true });

  const stderrFd = fs.openSync(stderrPath, "w");
  const holder = spawn("/bin/sh", ["-c", `${run} /bin/sh -c "$CDIR_TURN_HOLD"; echo $? > "$CDIR_TURN_READY.exit"`], {
    cwd: rootDir,
    // Its own process group, so a wait we give up can be ended whole.
    detached: true,
    stdio: ["ignore", "ignore", stderrFd],
    env: {
      ...(env ?? process.env),
      CDIR_TURN_READY: ready,
      CDIR_TURN_OWNER: String(process.pid),
      CDIR_TURN_HOLD: HOLD,
    },
  });
  fs.closeSync(stderrFd);
  // A holder that cannot start is seen below, by its missing pid; the event
  // loop never runs while we wait, and must not be kept alive after.
  holder.on("error", () => {});
  holder.unref();
  const pid = holder.pid;
  if (pid === undefined) {
    release();
    return { refused: `could not take the turn: "${run}" could not be started` };
  }

  const started = Date.now();
  for (;;) {
    const waited = Date.now() - started;
    if (fs.existsSync(ready)) {
      return { turn: { release, waitNote: waited > NOTEWORTHY_WAIT_MS ? ` (waited ${seconds(waited)}s for the turn)` : "" } };
    }
    const code = readText(exited);
    if (code !== "") {
      const why = readText(stderrPath).split("\n")[0].trim();
      release();
      return { refused: `could not take the turn: "${run}" exited ${code}${why ? `: ${why}` : ""}` };
    }
    if (waited >= waitMs) {
      try {
        // Still queueing, holding nothing: end it whole, so it cannot take the turn later.
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
      release();
      return { refused: `no turn within ${seconds(waitMs)}s: another check run held it` };
    }
    pause(Math.min(POLL_MS, waitMs - waited));
  }
}
