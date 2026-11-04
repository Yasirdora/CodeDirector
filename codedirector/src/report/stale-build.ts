/**
 * The stale-build finding: a workspace package whose git-ignored build
 * output — the files `main`, `module`, `types`, `typings` and `exports`
 * point into — is older than the sources the run changed. tsc and the tests
 * read that output, so an error about the package may describe a build from
 * hours ago instead of the change.
 *
 * Asserted, and said only where it can be true: the root must declare
 * workspaces, the package's outputs must be ignored (an output that is
 * tracked is not generated state), a changed file must lie outside them, and
 * the output must be older than those changes — or missing.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClassifiedChange } from "../run/classify";
import type { Finding } from "./report";

interface OutputTarget {
  /** The target as the package.json wrote it, minus a leading "./". */
  spec: string;
  /** Root-relative path, "/"-separated. */
  rel: string;
  /** The target's top folder inside the package: dist, build, lib. */
  folder: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A JSON object file, or null when absent, unreadable or not an object. */
function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

/** The root package.json's workspaces patterns — array form or { packages }. */
function workspacePatterns(rootDir: string): string[] {
  const root = readJsonObject(path.join(rootDir, "package.json"));
  if (!root) return [];
  const ws = root.workspaces;
  const list: unknown[] = Array.isArray(ws) ? ws : isObject(ws) && Array.isArray(ws.packages) ? ws.packages : [];
  return list.filter((p): p is string => typeof p === "string");
}

function hasGlobChars(p: string): boolean {
  return /[*?]/.test(p) || p.includes("[") || p.includes("{");
}

/**
 * Workspace package folders, root-relative and "/"-separated. Only `dir/*`
 * and a plain `dir` are expanded; every other glob form is ignored. A folder
 * without a package.json is not a package.
 */
function packageDirs(rootDir: string, patterns: string[]): string[] {
  const dirs = new Set<string>();
  const add = (rel: string): void => {
    const clean = rel.replace(/\/+$/, "");
    if (clean === "" || clean === "." || clean === ".." || clean.startsWith("../") || path.isAbsolute(clean)) return;
    if (fs.existsSync(path.join(rootDir, clean, "package.json"))) dirs.add(clean);
  };
  for (const raw of patterns) {
    const pattern = raw.replace(/\\/g, "/").replace(/\/+$/, "");
    const base = pattern.endsWith("/*") ? pattern.slice(0, -2) : null;
    if (base !== null) {
      if (base === "" || hasGlobChars(base)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(rootDir, base), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) add(`${base}/${entry.name}`);
      }
    } else if (!hasGlobChars(pattern)) {
      add(pattern);
    }
  }
  return [...dirs].sort();
}

/** Every string leaf of a value: exports maps nest objects, and may hold arrays. */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
    return;
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) stringLeaves(item, out);
  }
}

/** `git check-ignore -q`: true only for exit 0 — anything else is "not known to be ignored". */
function isIgnored(rootDir: string, rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], {
      cwd: rootDir,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** The package's ignored output targets — the only ones that name a build output. */
function outputTargets(rootDir: string, pkgDir: string, pkg: Record<string, unknown>): OutputTarget[] {
  const pkgAbs = path.join(rootDir, pkgDir);
  const specs: string[] = [];
  for (const key of ["main", "module", "types", "typings"]) {
    const value = pkg[key];
    if (typeof value === "string") specs.push(value);
  }
  stringLeaves(pkg.exports, specs);

  const seen = new Set<string>();
  const targets: OutputTarget[] = [];
  for (const raw of specs) {
    const spec = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (spec === "" || path.isAbsolute(spec) || hasGlobChars(spec)) continue;
    const abs = path.resolve(pkgAbs, spec);
    const inside = path.relative(pkgAbs, abs);
    if (inside === "" || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) continue;
    const rel = path.relative(rootDir, abs).split(path.sep).join("/");
    if (seen.has(rel) || !isIgnored(rootDir, rel)) continue;
    const parts = inside.split(path.sep).filter(Boolean);
    if (parts.length < 2) continue; // a file at the package root names no output folder
    seen.add(rel);
    targets.push({ spec, rel, folder: parts[0] });
  }
  return targets;
}

/** "path1, path2 and N more" — bounded, as every list in a finding is. */
function listPaths(paths: string[], limit: number): string {
  const shown = paths.slice(0, limit).join(", ");
  return paths.length > limit ? `${shown} and ${paths.length - limit} more` : shown;
}

/**
 * One finding per workspace package whose ignored build output is older than
 * the sources the run changed. Asserted: the mtimes are facts, the inference
 * ("an error about it may come from the old build") is the observation.
 */
export function staleBuildFindings(rootDir: string, changed: ClassifiedChange[]): Finding[] {
  const patterns = workspacePatterns(rootDir);
  if (patterns.length === 0) return [];
  const findings: Finding[] = [];

  for (const pkgDir of packageDirs(rootDir, patterns)) {
    const pkg = readJsonObject(path.join(rootDir, pkgDir, "package.json"));
    if (!pkg) continue;
    const touched = changed
      .map((c) => c.path.replace(/\\/g, "/"))
      .filter((p) => p === pkgDir || p.startsWith(`${pkgDir}/`));
    if (touched.length === 0) continue;

    const targets = outputTargets(rootDir, pkgDir, pkg);
    if (targets.length === 0) continue;
    const folders = [...new Set(targets.map((t) => t.folder))];
    const inOutput = (p: string): boolean =>
      folders.some((folder) => p === `${pkgDir}/${folder}` || p.startsWith(`${pkgDir}/${folder}/`));
    const sources = touched.filter((p) => !inOutput(p));
    if (sources.length === 0) continue;

    const name = typeof pkg.name === "string" && pkg.name.trim() !== "" ? pkg.name.trim() : pkgDir;
    const tail = `an error about "${name}" may come from the old build — build it first, or name the build in checks.yaml's refresh`;

    const outputTimes = targets.map((t) => {
      try {
        return fs.statSync(path.join(rootDir, t.rel)).mtimeMs;
      } catch {
        return null;
      }
    });
    const missingAt = outputTimes.indexOf(null);
    if (missingAt !== -1) {
      findings.push({
        text: `${pkgDir} has no build output (${targets[missingAt].spec}): ${tail}`,
        evidenceClass: "asserted",
      });
      continue;
    }

    const sourceTimes: number[] = [];
    for (const p of sources) {
      try {
        sourceTimes.push(fs.statSync(path.join(rootDir, p)).mtimeMs);
      } catch {
        // a source deleted before the report: it has no time to compare
      }
    }
    if (sourceTimes.length === 0) continue;
    const oldest = Math.min(...outputTimes.filter((m): m is number => m !== null));
    if (!(oldest < Math.max(...sourceTimes))) continue;

    findings.push({
      text: `${pkgDir}/${targets[0].folder} is older than its sources (the run changed ${listPaths(sources, 3)}): ${tail}`,
      evidenceClass: "asserted",
    });
  }
  return findings;
}
