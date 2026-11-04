/**
 * One claim file per cdir root: `.codedirector/running.json`.
 *
 * A run, a standalone verify and a report that re-runs the checks write it
 * before they do any work, rewrite it as they move from phase to phase, and
 * remove it when they end. Every process reads it — the CLI, another MCP
 * server, a second run: a second run on the same tree would corrupt the first
 * one's baseline, so it is refused, and a report shows what is running
 * instead of running the checks behind it.
 *
 * It is cdir state, never judged as a project change (core/state.ts), and it
 * does not live in .codedirector/runs/ — that folder holds one record per
 * finished attempt, and its contents are counted.
 *
 * Liveness is three facts: the claim is from this host, its pid is alive
 * (kill 0, or EPERM for a process of another user), and the process started
 * when the claim says (`ps lstart` within two seconds — a pid can be reused).
 * Without a start time from `ps` the kill check alone decides and the claim's
 * description says the start time was not checked. A claim from another host
 * is not judged here. A stale claim is never deleted: the next claimant
 * renames it into .codedirector/running-stale/ and says so once.
 *
 * Only the owner rewrites or removes the file: the pid and the claim's own
 * startedAt stamp must still match what is on disk.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { newRecordId, writeFileAtomic } from "../core/ids";
import { indexDir, stableStringify } from "../core/store";

export type ClaimKind = "run" | "verify" | "report";

/** What .codedirector/running.json holds while a run, verify or report works. */
export interface ClaimFile {
  formatVersion: 1;
  kind: ClaimKind;
  lockId: string;
  /** 1-based; for a run, this lock's recorded attempts + 1. */
  attempt: number;
  pid: number;
  host: string;
  /** ISO 8601: now − process.uptime(), the instant `ps lstart` is checked against. */
  processStartedAt: string;
  startedAt: string;
  /** The run's argv, or the verifyCommand text a verify or report executes. */
  command: string[] | string;
  phase: string;
  phaseSince: string;
  cdirVersion: string;
}

/** The facts a "running since …" line needs — a claim file, or a report's `running`. */
export interface ClaimDescription {
  kind: ClaimKind;
  lockId: string;
  attempt: number;
  pid: number;
  startedAt: string;
  phase: string;
  phaseSince: string;
}

export class ClaimError extends Error {}

export const RUNNING_FILE = "running.json";
export const STALE_DIR = "running-stale";
/** Root-relative, for the sentences: `.codedirector/running.json`. */
export const RUNNING_REL = path.join(".codedirector", RUNNING_FILE).split(path.sep).join("/");

/** `ps lstart` is whole seconds; a real process start is well within this. */
const START_TOLERANCE_MS = 2000;
/** How often a claimant may lose the create race before giving up. */
const ATTEMPTS = 4;

/** Claims this process holds, by resolved root: a nested claim shares one. */
const held = new Map<string, ClaimFile>();

export interface ClaimRequest {
  kind: ClaimKind;
  lockId: string;
  /** The run's argv, or the verifyCommand text. */
  command: string[] | string;
  /** First phase (default "starting"). */
  phase?: string;
}

export interface ClaimView {
  claim: ClaimFile;
  path: string;
  /** live · stale (its process is gone, or the pid was reused) · other-host (not judged here). */
  state: "live" | "stale" | "other-host";
  /** False when `ps` gave no start time for the pid: liveness is the kill check alone. */
  startChecked: boolean;
}

export interface ClaimHandle {
  file: ClaimFile;
  /** A stale claim set aside to make room, worded once; absent when there was none. */
  stale?: string;
  /** Record that the work moved on (owner rewrite, atomic). */
  phase(next: string): void;
  /** Remove the file — only while it is still this claim. */
  release(): void;
}

export function claimPath(rootDir: string): string {
  return path.join(indexDir(rootDir), RUNNING_FILE);
}

export function staleClaimsDir(rootDir: string): string {
  return path.join(indexDir(rootDir), STALE_DIR);
}

/** How many attempts this lock has recorded (a run's claim is that + 1). */
export function recordedAttempts(rootDir: string, lockId: string): number {
  try {
    return fs
      .readdirSync(path.join(indexDir(rootDir), "runs"))
      .filter((f) => f.startsWith(`${lockId}-`) && f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function cdirVersion(): string {
  try {
    // The package root is three levels up from dist/src/run, as for the MCP server.
    return String(require("../../../package.json").version);
  } catch {
    return "unknown";
  }
}

function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function processAlive(pid: number): boolean {
  // pid 0 would signal this process group — a claim never names it.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: alive, but owned by another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * When the process started, from `ps lstart`; undefined when ps cannot say
 * (dead pid, no ps, output it cannot parse). LC_ALL=C keeps the month name
 * parseable by Date — a localised one is not.
 */
function processStartedAt(pid: number): Date | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  let text: string;
  try {
    text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch {
    return undefined;
  }
  const at = Date.parse(text.trim());
  return Number.isNaN(at) ? undefined : new Date(at);
}

function judge(claim: ClaimFile, file: string): ClaimView {
  if (claim.host !== os.hostname()) return { claim, path: file, state: "other-host", startChecked: false };
  if (!processAlive(claim.pid)) return { claim, path: file, state: "stale", startChecked: false };
  const started = processStartedAt(claim.pid);
  const said = Date.parse(claim.processStartedAt);
  if (started === undefined || Number.isNaN(said)) {
    return { claim, path: file, state: "live", startChecked: false };
  }
  return {
    claim,
    path: file,
    state: Math.abs(started.getTime() - said) <= START_TOLERANCE_MS ? "live" : "stale",
    startChecked: true,
  };
}

function subject(c: ClaimDescription): string {
  return c.kind === "run" ? `${c.lockId} attempt ${c.attempt}` : `${c.lockId} ${c.kind}`;
}

/** "IL-0952 attempt 2 is running since 13:52 (pid 4711), now on verifyCommand since 14:05" */
export function describeClaim(c: ClaimDescription, startChecked = true): string {
  const note = startChecked ? "" : ", start time not checked";
  return (
    `${subject(c)} is running since ${clock(c.startedAt)} (pid ${c.pid}${note}), ` +
    `now on ${c.phase} since ${clock(c.phaseSince)}`
  );
}

/** The one line a report or `lock show` puts in front: "Running now: …". */
export function runningNowLine(c: ClaimDescription, startChecked = true): string {
  return `Running now: ${describeClaim(c, startChecked)}`;
}

/** The refusal a second process gets: the claim's description, then what to do. */
export function claimRefusal(view: ClaimView): string {
  const c = view.claim;
  if (view.state === "other-host") {
    return (
      `${describeClaim(c, view.startChecked)} on ${c.host} — a claim from another machine is not judged here; ` +
      `wait for it, or if ${c.host} is not running cdir, remove ${RUNNING_REL} by hand`
    );
  }
  return (
    `${describeClaim(c, view.startChecked)} — wait for it, or follow it with ` +
    `\`cdir report ${c.lockId}\`; do not start it again`
  );
}

/** "found a stale claim from IL-0952 (pid 4711, since 13:52): kept in …, ignored" */
export function staleLine(c: ClaimFile, keptIn: string): string {
  return `found a stale claim from ${c.lockId} (pid ${c.pid}, since ${clock(c.startedAt)}): kept in ${keptIn}, ignored`;
}

function readFile(file: string): ClaimFile | "unreadable" | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const data = JSON.parse(text) as Partial<ClaimFile>;
    if (data && data.formatVersion === 1 && typeof data.pid === "number" && typeof data.lockId === "string") {
      return data as ClaimFile;
    }
  } catch {
    // unparsable: reported as such below
  }
  return "unreadable";
}

function parseClaim(file: string): ClaimFile | null {
  const onDisk = readFile(file);
  return onDisk === null || onDisk === "unreadable" ? null : onDisk;
}

/** Rename the stale claim aside; null when another claimant moved it first (ENOENT). */
function stow(rootDir: string, file: string): string | null {
  const dir = staleClaimsDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${newRecordId()}.json`);
  try {
    fs.renameSync(file, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return path.relative(rootDir, dest).split(path.sep).join("/");
}

function rewrite(rootDir: string, claim: ClaimFile, next: string): void {
  if (claim.phase === next) return;
  // Only our own claim is rewritten: another process may have taken the file
  // for stale and made its own.
  const onDisk = parseClaim(claimPath(rootDir));
  if (!onDisk || onDisk.pid !== claim.pid || onDisk.startedAt !== claim.startedAt) return;
  claim.phase = next;
  claim.phaseSince = new Date().toISOString();
  writeFileAtomic(claimPath(rootDir), stableStringify(claim));
}

function handleFor(rootDir: string, key: string, claim: ClaimFile, stale?: string): ClaimHandle {
  return {
    file: claim,
    ...(stale !== undefined ? { stale } : {}),
    phase: (next: string) => rewrite(rootDir, claim, next),
    release: () => {
      // This process holds nothing from here on, whatever is on disk: a claim
      // another process put in our place must refuse us, not be shared.
      held.delete(key);
      // Remove only our own claim; a missing, unreadable or other file stays.
      const onDisk = parseClaim(claimPath(rootDir));
      if (!onDisk || onDisk.pid !== claim.pid || onDisk.startedAt !== claim.startedAt) return;
      fs.rmSync(claimPath(rootDir), { force: true });
    },
  };
}

/**
 * Claim this root for the work starting now, or throw the refusal a second
 * process deserves. A claim this process already holds (a verify inside a
 * re-verifying report) is shared: the same file, and only the outer call
 * removes it.
 */
export function claimRoot(rootDir: string, want: ClaimRequest): ClaimHandle {
  const key = path.resolve(rootDir);
  const mine = held.get(key);
  if (mine) {
    return { file: mine, phase: (next: string) => rewrite(rootDir, mine, next), release: () => {} };
  }

  fs.mkdirSync(indexDir(rootDir), { recursive: true });
  const file = claimPath(rootDir);
  const now = new Date().toISOString();
  const claim: ClaimFile = {
    formatVersion: 1,
    kind: want.kind,
    lockId: want.lockId,
    attempt: recordedAttempts(rootDir, want.lockId) + (want.kind === "run" ? 1 : 0),
    pid: process.pid,
    host: os.hostname(),
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    startedAt: now,
    command: want.command,
    phase: want.phase ?? "starting",
    phaseSince: now,
    cdirVersion: cdirVersion(),
  };

  let stale: string | undefined;
  for (let tries = 0; tries < ATTEMPTS; tries++) {
    const onDisk = readFile(file);
    if (onDisk === "unreadable") {
      const kept = stow(rootDir, file);
      if (kept === null) continue; // another claimant moved it: create instead
      stale ??= `found an unreadable claim (${RUNNING_REL}): kept in ${kept}, ignored`;
    } else if (onDisk !== null) {
      const view = judge(onDisk, file);
      if (view.state !== "stale") throw new ClaimError(claimRefusal(view));
      const kept = stow(rootDir, file);
      if (kept === null) continue;
      stale ??= staleLine(onDisk, kept);
    }
    // Publish the whole file at once: write it beside, then hard-link it into
    // place. link() fails with EEXIST while a claim is there, so exactly one
    // claimant wins — and a reader never sees a half-written claim. (A `wx`
    // create is empty until its write lands; an empty claim reads as
    // unreadable, and the next claimant would set it aside as stale.)
    const tmp = `${file}.${process.pid}.${newRecordId()}.tmp`;
    try {
      fs.writeFileSync(tmp, stableStringify(claim), { flag: "wx" });
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; // another claimant won
      throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    held.set(key, claim);
    return handleFor(rootDir, key, claim, stale);
  }
  throw new ClaimError(`could not claim ${RUNNING_REL}: another process keeps taking it — try again`);
}

/** The claim on this root, judged — or null when none is recorded or it cannot be read. */
export function readClaim(rootDir: string): ClaimView | null {
  const file = claimPath(rootDir);
  const onDisk = readFile(file);
  if (onDisk === null || onDisk === "unreadable") return null;
  return judge(onDisk, file);
}

/** Move the claim this process holds on `rootDir` to a new phase; a no-op when it holds none. */
export function phaseFor(rootDir: string, phase: string): void {
  const mine = held.get(path.resolve(rootDir));
  if (mine) rewrite(rootDir, mine, phase);
}
