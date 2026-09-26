/**
 * JavaScript/TypeScript module resolution: a relative specifier plus the
 * importing file's directory, tried against the extensions and index files
 * Node and TypeScript accept. Bare specifiers ("react", "node:fs") name
 * packages, which are not indexed, and resolve to nothing.
 */

import type { RepoIndex } from "../../core/types";
import * as path from "node:path";

/** Normalize a module specifier + importing file to an indexed relpath, or null. */
export function resolveNodeImport(
  fromFile: string,
  specifier: string,
  hasFile: (relPath: string) => boolean,
): string | null {
  if (!specifier.startsWith(".")) return null; // external/bare imports are not indexed
  const fromDir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ];
  // specifier "./x.js" may refer to x.ts on disk (NodeNext style)
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  if (stripped !== base) {
    candidates.push(`${stripped}.ts`, `${stripped}.tsx`);
  }
  for (const c of candidates) {
    if (hasFile(c)) return c;
  }
  return null;
}

/** The index-based form, kept for the public API (`import { resolveModule } from "codedirector"`). */
export function resolveModule(fromFile: string, specifier: string, index: RepoIndex): string | null {
  return resolveNodeImport(fromFile, specifier, (p) => index.files[p] !== undefined);
}
