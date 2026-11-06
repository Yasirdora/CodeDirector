/**
 * Where a project's dependency manifests are (W7).
 *
 * A manifest counts wherever it sits in the project, not only at the root:
 * a workspace's packages/a/package.json and an Apple project's
 * apple/Core/Package.swift declare dependencies as much as the root's do.
 * The names come from the registered domains (DomainRegistry's
 * dependencyManifests); the files from git, tracked and untracked but never
 * ignored, so a copy inside a build or vendor folder (node_modules, .build,
 * DerivedData, Pods) is never one. Outside git only the root is looked at,
 * as before.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DomainRegistry } from "../domain/registry";
import { CORE_SKIP_DIRS } from "./walk";

/** Root-relative paths, forward slashes, sorted: every dependency manifest present now. */
export function presentManifests(rootDir: string, domains: DomainRegistry): string[] {
  const names = new Set(domains.dependencyManifests().map((m) => m.path));
  if (names.size === 0) return [];
  const skip = new Set([...CORE_SKIP_DIRS, ...domains.neverSourceDirs()]);
  let listed: string[];
  try {
    listed = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...[...names].map((n) => `:(glob)**/${n}`)],
      { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000, maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    listed = [...names]; // not a git repository: the root only
  }
  const out = new Set<string>();
  for (const rel of listed) {
    const parts = rel.split("/");
    if (!names.has(parts[parts.length - 1])) continue;
    if (parts.slice(0, -1).some((part) => skip.has(part))) continue;
    // --cached lists a tracked manifest the work tree has deleted: absent is not present.
    if (fs.existsSync(path.join(rootDir, rel))) out.add(rel);
  }
  return [...out].sort();
}

/** A manifest at the root: the only place versions before W7 looked. */
export function isRootManifest(relPath: string): boolean {
  return !relPath.includes("/");
}
