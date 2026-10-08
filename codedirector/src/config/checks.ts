/**
 * The repo's rules for required checks: `.codedirector/checks.yaml`.
 *
 * A verifyCommand is free text, so nothing says which checks a part of the
 * repo needs. This file does: it names the checks, and says which areas of
 * the repo need which. Drafting, activation, runs and reports all read it
 * through here, so there is one parser, one matching rule and one wording
 * for a bad file.
 *
 * The file is optional. Without it nothing here applies, and Code Director
 * behaves exactly as before. The commands in it are opaque strings: the core
 * never reads what they run (ADR 0001).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { matchPath, validateGlob } from "../lock/glob";

export const CHECKS_FILE = ".codedirector/checks.yaml";
const CHECKS_SCHEMA_VERSION = 1;
const CHECK_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface CheckDef {
  name: string;
  /** What a drafted lock runs. */
  run: string;
  /** The text a verifyCommand must contain to count as running this check. */
  match: string;
}

export interface CheckArea {
  /** Root-relative globs; a plain path is a directory prefix, as everywhere else. */
  paths: string[];
  /** Names of checks from `ChecksRules.checks`. */
  need: string[];
}

/** How long a check run waits for its turn before it gives up: two hours. */
export const DEFAULT_TURN_WAIT_MS = 2 * 60 * 60 * 1000;

export interface TurnsRule {
  /** A command prefix that takes the shared turn for as long as the command it wraps runs. */
  run: string;
  /** How long to wait for the turn. */
  waitMs: number;
}

export interface ChecksRules {
  /** In the order the file lists them — the order of every answer. */
  checks: CheckDef[];
  areas: CheckArea[];
  /** Set when the file asks check runs to take turns. */
  turns?: TurnsRule;
}

/**
 * The rules file as found. An invalid file is a result, not a throw: every
 * caller must decide what to do with it, and each of them fails closed.
 * `error` is the whole sentence — the file and the reason — so no caller
 * words it again.
 */
export type ChecksFile =
  | { status: "absent" }
  | { status: "rules"; rules: ChecksRules }
  | { status: "invalid"; error: string };

class ChecksParseError extends Error {}

function err(msg: string): never {
  throw new ChecksParseError(msg);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A blank string would match every command, so blank counts as empty. */
function reqString(v: unknown, where: string): string {
  if (typeof v !== "string" || v.trim() === "") err(`${where} must be a non-empty string`);
  return v;
}

function reqStringList(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.length === 0) err(`${where} must be a non-empty list`);
  return v.map((x, i) => reqString(x, `${where}[${i}]`));
}

/** An unknown key is an error: a typo like `area:` must not switch rules off. */
function onlyKeys(obj: Record<string, unknown>, valid: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!valid.includes(key)) err(`${where} has unknown key "${key}" (valid: ${valid.join(", ")})`);
  }
}

function parseCheck(name: string, def: unknown): CheckDef {
  const where = `checks.${name}`;
  if (!CHECK_NAME.test(name)) err(`${where}: a check name must match ${CHECK_NAME.source}`);
  if (typeof def === "string") {
    const run = reqString(def, where);
    return { name, run, match: run };
  }
  if (!isObj(def)) err(`${where} must be a command, or a mapping with run (and optionally match)`);
  onlyKeys(def, ["run", "match"], where);
  const run = reqString(def.run, `${where}.run`);
  return { name, run, match: def.match === undefined ? run : reqString(def.match, `${where}.match`) };
}

function parseArea(raw: unknown, i: number, known: Set<string>): CheckArea {
  const where = `areas[${i}]`;
  if (!isObj(raw)) err(`${where} must be a mapping with paths and need`);
  onlyKeys(raw, ["paths", "need"], where);
  const paths = reqStringList(raw.paths, `${where}.paths`);
  paths.forEach((p, j) => {
    const problem = validateGlob(p);
    if (problem) err(`${where}.paths[${j}] "${p}": ${problem}`);
  });
  const need = reqStringList(raw.need, `${where}.need`);
  for (const name of need) {
    if (!known.has(name)) {
      err(`${where}.need names "${name}", which is not in checks (${[...known].join(", ") || "none"})`);
    }
  }
  return { paths, need };
}

function parseTurns(def: unknown): TurnsRule {
  if (typeof def === "string") return { run: reqString(def, "turns"), waitMs: DEFAULT_TURN_WAIT_MS };
  if (!isObj(def)) err("turns must be a non-empty string, or a mapping with run (and optionally waitMs)");
  onlyKeys(def, ["run", "waitMs"], "turns");
  const run = reqString(def.run, "turns.run");
  const waitMs = def.waitMs === undefined ? DEFAULT_TURN_WAIT_MS : def.waitMs;
  if (typeof waitMs !== "number" || !Number.isInteger(waitMs) || waitMs <= 0) {
    err("turns.waitMs must be a positive integer");
  }
  return { run, waitMs };
}

function parseChecks(text: string): ChecksRules {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    err(`invalid YAML — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObj(raw)) err("top level must be a mapping");
  onlyKeys(raw, ["schemaVersion", "checks", "areas", "turns"], "top level");
  if (raw.schemaVersion !== CHECKS_SCHEMA_VERSION) {
    err(`schemaVersion must be ${CHECKS_SCHEMA_VERSION}, got ${JSON.stringify(raw.schemaVersion)}`);
  }

  const rawChecks = raw.checks ?? {};
  if (!isObj(rawChecks)) err("checks must be a mapping of check name to command");
  const checks = Object.entries(rawChecks).map(([name, def]) => parseCheck(name, def));

  const rawAreas = raw.areas ?? [];
  if (!Array.isArray(rawAreas)) err("areas must be a list");
  const known = new Set(checks.map((c) => c.name));
  const areas = rawAreas.map((a, i) => parseArea(a, i, known));

  return {
    checks,
    areas,
    ...(raw.turns !== undefined ? { turns: parseTurns(raw.turns) } : {}),
  };
}

/** Read `<root>/.codedirector/checks.yaml`. Never throws for a bad file. */
export function loadChecks(rootDir: string): ChecksFile {
  const invalid = (reason: string): ChecksFile => ({
    status: "invalid",
    error: `${CHECKS_FILE} is invalid: ${reason}`,
  });
  let text: string;
  try {
    text = fs.readFileSync(path.join(rootDir, CHECKS_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return invalid(`could not be read — ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return { status: "rules", rules: parseChecks(text) };
  } catch (e) {
    if (e instanceof ChecksParseError) return invalid(e.message);
    throw e;
  }
}

/** A check some files need, with the files that need it. */
export interface NeededCheck {
  check: CheckDef;
  files: string[];
}

/**
 * The checks `files` need: for each check, the files of any area that
 * names it. A file in several areas needs the union of their checks; a file
 * in no area needs none. Output follows the order of `rules.checks`.
 */
export function checksNeededBy(rules: ChecksRules, files: string[]): NeededCheck[] {
  const needed: NeededCheck[] = [];
  for (const check of rules.checks) {
    const needing = files.filter((f) =>
      rules.areas.some((a) => a.need.includes(check.name) && a.paths.some((p) => matchPath(p, f))),
    );
    if (needing.length > 0) needed.push({ check, files: needing });
  }
  return needed;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Whether `text` appears in `command`, both read with whitespace collapsed.
 * Nothing cleverer — a command is a string, not a manifest. This one rule
 * decides both "the verifyCommand runs a check" and "it takes the turn itself".
 */
export function containsCommand(command: string, text: string): boolean {
  return squash(command).includes(squash(text));
}

/** Whether a verifyCommand runs a check: the check's `match` text is in it. */
export function runsCheck(verifyCommand: string, check: CheckDef): boolean {
  return containsCommand(verifyCommand, check.match);
}

/** One verifyCommand that runs every one of these checks. */
export function joinRuns(needed: NeededCheck[]): string {
  return needed.map((n) => n.check.run).join(" && ");
}
