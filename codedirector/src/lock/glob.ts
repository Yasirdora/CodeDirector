/**
 * Glob matching for deny lists, budget files, and test globs.
 *
 * Supported syntax: `*` (within a path segment), `?` (single char, not `/`),
 * `**` (any number of segments). A pattern with no glob characters matches
 * the exact path or any path beneath it treated as a directory prefix
 * ("src/export.ts" matches itself; "Export" matches "Export/Encoder.swift").
 * Matching is on root-relative, forward-slash paths. Pure and deterministic.
 */

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**" — any segments; a following "/" is optional
        re += ".*";
        i += 2;
        if (glob[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export function hasGlobChars(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** True if `relPath` (forward slashes, root-relative) matches the pattern. */
export function matchPath(pattern: string, relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  const pat = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!hasGlobChars(pat)) {
    return p === pat || p.startsWith(pat + "/");
  }
  return globToRegExp(pat).test(p);
}

/**
 * Validate a deny/test glob pattern. Returns an error string, or null if OK.
 * Rules: non-empty, no absolute paths, no `..` segments, no backslash escapes.
 */
export function validateGlob(pattern: string): string | null {
  if (typeof pattern !== "string" || pattern.trim() === "") return "pattern is empty";
  if (pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern))
    return "absolute paths are not allowed (use root-relative paths)";
  if (pattern.split("/").some((seg) => seg === "..")) return "'..' segments are not allowed";
  if (pattern.includes("\\")) return "use forward slashes, not backslashes";
  try {
    globToRegExp(pattern);
  } catch {
    return "pattern does not compile";
  }
  return null;
}
