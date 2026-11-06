/**
 * The tests a failed check's result files name (`results` in
 * .codedirector/checks.yaml).
 *
 * Some runners say nothing on their console about which test failed:
 * `xcodebuild test -quiet` ends on "Testing started" and an exit code. The
 * result file it writes knows. When such a check fails, the files at its
 * `results` path written since the check started are read, newest first, by
 * the domain that knows their kind — the core only lists them and runs the
 * domain's command, bounded and supervised.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DomainRegistry } from "../domain/registry";
import { runArgvProbe } from "../run/probe";

/** At most this many result files are read for one failure. */
export const MAX_RESULT_FILES = 3;
/** How long one result file may take to read. */
export const RESULT_READ_TIMEOUT_MS = 60_000;
/** A file's time may trail the check's start marker by this much (file systems round). */
const SLACK_MS = 2_000;

export interface ResultsRead {
  /** Distinct failed tests, in the order the files named them. */
  tests: string[];
  /** The first failure's message, when a file gave one. */
  message?: string;
  /** The files the tests were read from (absolute paths). */
  files: string[];
  /** What could not be read, each said in a few words. */
  problems: string[];
}

/** A `*` in the last part of a path as a regular expression for a name. */
function namePattern(base: string): RegExp {
  const parts = base.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`);
}

/**
 * Read the result files at `pattern` (absolute, or from `rootDir`) that
 * were written at or after `sinceMs`.
 */
export function readCheckResults(
  rootDir: string,
  pattern: string,
  sinceMs: number,
  domains: DomainRegistry,
  env?: NodeJS.ProcessEnv,
): ResultsRead {
  const out: ResultsRead = { tests: [], files: [], problems: [] };
  const dir = path.resolve(rootDir, path.dirname(pattern));
  const match = namePattern(path.basename(pattern));
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => match.test(n));
  } catch {
    out.problems.push(`no folder ${dir}`);
    return out;
  }
  const fresh = names
    .map((n) => {
      try {
        return { file: path.join(dir, n), at: fs.statSync(path.join(dir, n)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((f): f is { file: string; at: number } => f !== null && f.at >= sinceMs - SLACK_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_RESULT_FILES);
  if (fresh.length === 0) {
    out.problems.push(`no result file at ${pattern} written since the check started`);
    return out;
  }
  for (const { file } of fresh) {
    const name = path.basename(file);
    const reader = domains.resultReader(name);
    if (!reader) {
      out.problems.push(`no reader for ${name}`);
      continue;
    }
    const probe = runArgvProbe(rootDir, reader.argv(file), RESULT_READ_TIMEOUT_MS, env);
    if (probe.timedOut || probe.exitCode !== 0) {
      out.problems.push(
        `${name} could not be read (${probe.timedOut ? `timed out after ${RESULT_READ_TIMEOUT_MS / 1000}s` : `exit ${probe.exitCode ?? "?"}`})`,
      );
      continue;
    }
    const read = reader.failures(probe.stdout);
    for (const test of read.tests) if (!out.tests.includes(test)) out.tests.push(test);
    if (out.message === undefined && read.message !== undefined) out.message = read.message;
    if (read.tests.length > 0) out.files.push(file);
  }
  return out;
}
