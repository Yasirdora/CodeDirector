/**
 * Persistence for the structural index: .codedirector/index.json
 *
 * Writes are deterministic: file keys sorted, JSON pretty-printed with a
 * stable key order. Downstream stages (Change Report) rely on byte-stable
 * output for identical inputs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { INDEX_SCHEMA_VERSION, RepoIndex } from "./types";

export function indexDir(rootDir: string): string {
  return path.join(rootDir, ".codedirector");
}

export function indexPath(rootDir: string): string {
  return path.join(indexDir(rootDir), "index.json");
}

export function emptyIndex(): RepoIndex {
  return { schemaVersion: INDEX_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), files: {} };
}

export function loadIndex(rootDir: string): RepoIndex | null {
  const p = indexPath(rootDir);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as RepoIndex;
    if (data.schemaVersion !== INDEX_SCHEMA_VERSION) return null; // stale schema → full rebuild
    return data;
  } catch {
    return null; // corrupt index → full rebuild
  }
}

/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** cdir's own ignore rules, in .codedirector/.gitignore: paths are relative to that folder. */
export const CODEDIRECTOR_GITIGNORE =
  "# Code Director's working state. Locks stay commitable.\n" +
  "/index.json\n" +
  "/baselines/\n" +
  "/runs/\n" +
  "/ckpt-blobs/\n" +
  "/checkpoints.json\n";

/**
 * Ensure git ignores tool state (locks stay commitable). The rules go in
 * .codedirector/.gitignore — never the project's own .gitignore. A project
 * that already has the block older versions wrote there
 * (`# BEGIN cdir … # END cdir`) is left as it is: that block still works.
 * Idempotent; an existing .codedirector/.gitignore is never rewritten.
 */
export function ensureCodedirectorIgnore(rootDir: string): void {
  try {
    if (fs.readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes("# BEGIN cdir")) return;
  } catch {
    // no .gitignore: nothing older to honour
  }
  const p = path.join(indexDir(rootDir), ".gitignore");
  if (fs.existsSync(p)) return;
  fs.mkdirSync(indexDir(rootDir), { recursive: true });
  fs.writeFileSync(p, CODEDIRECTOR_GITIGNORE);
}

export function saveIndex(rootDir: string, index: RepoIndex): void {
  fs.mkdirSync(indexDir(rootDir), { recursive: true });
  ensureCodedirectorIgnore(rootDir);
  const sortedFiles: RepoIndex["files"] = {};
  for (const key of Object.keys(index.files).sort()) sortedFiles[key] = index.files[key];
  const toWrite: RepoIndex = { ...index, files: sortedFiles };
  fs.writeFileSync(indexPath(rootDir), stableStringify(toWrite), "utf8");
}
