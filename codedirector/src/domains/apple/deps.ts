/**
 * Dependency fingerprint for no-new-dependency on a Package.swift: hash the
 * package's `.package(…)` entries, not the whole file. A new target, a
 * resource, a platform or a comment is not a new dependency; a package added,
 * removed or moved to another version or place is.
 *
 * A small scanner, not a Swift parser: comments go, whitespace outside string
 * literals goes, and every `.package(` call is read to its closing
 * parenthesis. The entries are sorted, so their order never counts. A call
 * that never closes, or a file with no entry at all, still fingerprints —
 * the first as its remaining text, the second as an empty list.
 */

import { hashContent } from "../../core/builder";

/** The file without comments and without whitespace outside string literals. */
function squeeze(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (!/\s/.test(c)) out += c;
    i++;
  }
  return out;
}

/** Every `.package(…)` call, squeezed, sorted. */
export function swiftPackageEntries(source: string): string[] {
  const text = squeeze(source);
  const entries: string[] = [];
  let at = text.indexOf(".package(");
  while (at !== -1) {
    let depth = 0;
    let end = at + ".package".length;
    for (; end < text.length; end++) {
      const c = text[end];
      if (c === '"') {
        end++;
        while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")" && --depth === 0) break;
    }
    entries.push(text.slice(at, end + 1));
    at = text.indexOf(".package(", end + 1);
  }
  return entries.sort();
}

export function swiftPackageFingerprint(packageSwiftText: string): string {
  return "swiftpm:" + hashContent(JSON.stringify(swiftPackageEntries(packageSwiftText)));
}
