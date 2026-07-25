/**
 * Dependency fingerprint for no-new-dependency: hash the dependency
 * maps, not the whole package.json (description/script edits are not
 * new dependencies).
 */

import { hashContent } from "../core/builder";

const DEP_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundleDependencies",
  "bundledDependencies",
] as const;

/** Recursively sort object keys so key ORDER never changes the fingerprint. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function dependencyFingerprint(packageJsonText: string): string {
  try {
    const j = JSON.parse(packageJsonText) as Record<string, unknown>;
    const pick: Record<string, unknown> = {};
    for (const k of DEP_KEYS) {
      if (j[k] !== undefined) pick[k] = j[k];
    }
    return "deps:" + hashContent(JSON.stringify(sortKeysDeep(pick)));
  } catch {
    return hashContent(packageJsonText);
  }
}
