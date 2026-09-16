/**
 * Stable YAML round-trip for Vibe Checks.
 *
 * Writes are deterministic: keys are emitted in a fixed schema order and
 * list order is semantic (never re-sorted on write — the human's ordering
 * is preserved). Parsing validates structure strictly and throws
 * LockParseError with a readable message on any schema violation.
 */

import YAML from "yaml";
import {
  VibeCheck,
  KeepClause,
  KEEP_CLAUSE_KINDS,
  LOCK_SCHEMA_VERSION,
  LOCK_STATUSES,
  LockAssumption,
  LockBudget,
} from "./types";

export class LockParseError extends Error {}

function err(msg: string): never {
  throw new LockParseError(`Vibe Check YAML: ${msg}`);
}

// ---------------------------------------------------------------------
// Serialization (canonical key order)

function clauseToYaml(c: KeepClause): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: c.kind };
  if (c.command !== undefined) out.command = c.command;
  if (c.fixtures !== undefined) out.fixtures = c.fixtures;
  if (c.symbols !== undefined) out.symbols = c.symbols;
  if (c.glob !== undefined) out.glob = c.glob;
  if (c.text !== undefined) out.text = c.text;
  return out;
}

function budgetToYaml(b: LockBudget): Record<string, unknown> {
  return { files: b.files, symbols: b.symbols, maxFiles: b.maxFiles, maxLines: b.maxLines };
}

function assumptionToYaml(a: LockAssumption): Record<string, unknown> {
  return { text: a.text, source: a.source, confirmed: a.confirmed };
}

/** Serialize a Lock to YAML with canonical key order. Stable for stable input. */
export function lockToYaml(lock: VibeCheck): string {
  const doc: Record<string, unknown> = {
    schemaVersion: lock.schemaVersion,
    id: lock.id,
    status: lock.status,
    utterance: lock.utterance,
    goal: lock.goal,
    interpretation: lock.interpretation,
    keep: lock.keep.map(clauseToYaml),
    deny: lock.deny,
    change: lock.change,
    ...(lock.verifyCommand !== undefined ? { verifyCommand: lock.verifyCommand } : {}),
    ...(lock.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: lock.verifyTimeoutMs } : {}),
    ...(lock.verifyCovers !== undefined ? { verifyCovers: lock.verifyCovers } : {}),
    budget: budgetToYaml(lock.budget),
    accept: lock.accept,
    assumptions: lock.assumptions.map(assumptionToYaml),
    createdAt: lock.createdAt,
    createdBy: lock.createdBy,
  };
  return YAML.stringify(doc, { lineWidth: 0 });
}

// ---------------------------------------------------------------------
// Parsing + validation

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqString(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string") err(`${where}.${key} must be a string`);
  return v;
}

function strList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    err(`${where} must be a list of strings`);
  return v as string[];
}

function reqInt(obj: Record<string, unknown>, key: string, where: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v)) err(`${where}.${key} must be an integer`);
  return v;
}

function parseClause(v: unknown, i: number): KeepClause {
  const where = `keep[${i}]`;
  if (!isObj(v)) err(`${where} must be a mapping`);
  const kind = reqString(v, "kind", where);
  if (!(KEEP_CLAUSE_KINDS as string[]).includes(kind))
    err(
      `${where}.kind "${kind}" is not admissible — a Lock rejects clauses it cannot ` +
        `in principle check (valid: ${KEEP_CLAUSE_KINDS.join(", ")}); ` +
        `use kind: custom for human-judged clauses`,
    );
  const clause: KeepClause = { kind: kind as KeepClause["kind"] };
  if (v.command !== undefined) clause.command = reqString(v, "command", where);
  if (v.fixtures !== undefined) clause.fixtures = strList(v.fixtures, `${where}.fixtures`);
  if (v.symbols !== undefined) clause.symbols = strList(v.symbols, `${where}.symbols`);
  if (v.glob !== undefined) clause.glob = reqString(v, "glob", where);
  if (v.text !== undefined) clause.text = reqString(v, "text", where);
  return clause;
}

function parseAssumption(v: unknown, i: number): LockAssumption {
  const where = `assumptions[${i}]`;
  if (!isObj(v)) err(`${where} must be a mapping`);
  const source = reqString(v, "source", where);
  if (source !== "user" && source !== "system") err(`${where}.source must be "user" or "system"`);
  const confirmed = v.confirmed;
  if (typeof confirmed !== "boolean") err(`${where}.confirmed must be a boolean`);
  return { text: reqString(v, "text", where), source, confirmed };
}

/** Parse and validate a Lock YAML document. Throws LockParseError. */
export function lockFromYaml(text: string): VibeCheck {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    err(`invalid YAML — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObj(raw)) err("top level must be a mapping");

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion !== LOCK_SCHEMA_VERSION)
    err(`schemaVersion must be ${LOCK_SCHEMA_VERSION}, got ${JSON.stringify(schemaVersion)}`);

  const status = reqString(raw, "status", "lock");
  if (!(LOCK_STATUSES as string[]).includes(status))
    err(`status "${status}" invalid (valid: ${LOCK_STATUSES.join(", ")})`);

  if (!isObj(raw.budget)) err("budget must be a mapping");
  const budget: LockBudget = {
    files: strList(raw.budget.files, "budget.files"),
    symbols: strList(raw.budget.symbols, "budget.symbols"),
    maxFiles: reqInt(raw.budget, "maxFiles", "budget"),
    maxLines: reqInt(raw.budget, "maxLines", "budget"),
  };

  const keepRaw = raw.keep === undefined ? [] : raw.keep;
  if (!Array.isArray(keepRaw)) err("keep must be a list");
  const assumptionsRaw = raw.assumptions === undefined ? [] : raw.assumptions;
  if (!Array.isArray(assumptionsRaw)) err("assumptions must be a list");

  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id: reqString(raw, "id", "lock"),
    status: status as VibeCheck["status"],
    utterance: reqString(raw, "utterance", "lock"),
    goal: reqString(raw, "goal", "lock"),
    interpretation: reqString(raw, "interpretation", "lock"),
    keep: keepRaw.map(parseClause),
    deny: strList(raw.deny, "deny"),
    change: reqString(raw, "change", "lock"),
    ...(raw.verifyCommand !== undefined
      ? { verifyCommand: reqString(raw, "verifyCommand", "lock") }
      : {}),
    ...(raw.verifyTimeoutMs !== undefined
      ? { verifyTimeoutMs: reqInt(raw, "verifyTimeoutMs", "lock") }
      : {}),
    ...(raw.verifyCovers !== undefined
      ? { verifyCovers: strList(raw.verifyCovers, "verifyCovers") }
      : {}),
    budget,
    accept: strList(raw.accept, "accept"),
    assumptions: assumptionsRaw.map(parseAssumption),
    createdAt: reqString(raw, "createdAt", "lock"),
    createdBy: reqString(raw, "createdBy", "lock"),
  };
}
