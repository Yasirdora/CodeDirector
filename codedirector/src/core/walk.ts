/**
 * Repository walker.
 *
 * Walks a root directory for indexable source files, always skipping
 * .git / node_modules / dist / .codedirector and the Xcode build-product
 * directories (DerivedData, .build, .swiftpm, Pods, Carthage), and honoring
 * the root .gitignore (plus .ignore). Nested .gitignore files are NOT honored
 * (documented MVP limitation); the common case — root-level ignore files —
 * is covered. Because the walker prunes ignored directories, everything
 * under an ignored directory is skipped automatically.
 *
 * The matcher supports the gitignore subset that matters for source trees:
 * comments (#), negation (!), directory-only patterns (trailing /),
 * anchored patterns (leading / or containing /), and * / ** / ? globs.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const INDEXABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const ALWAYS_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".codedirector",
  // Apple/Xcode build products — routinely gigabytes, never source
  "DerivedData",
  ".build",
  ".swiftpm",
  "Pods",
  "Carthage",
]);

interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

function globToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"; // ** crosses directory boundaries
        i += 2;
        if (glob[i] === "/") i += 1; // "**/" also matches zero directories
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
  return new RegExp("^" + re + "$");
}

function parseIgnoreFile(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    } else if (line.includes("/")) {
      anchored = true;
    }
    if (!line) continue;
    rules.push({ negate, dirOnly, anchored, regex: globToRegex(line) });
  }
  return rules;
}

export class RepoWalker {
  private rules: IgnoreRule[] = [];

  constructor(private rootDir: string) {
    for (const name of [".gitignore", ".ignore"]) {
      const p = path.join(rootDir, name);
      if (fs.existsSync(p)) {
        this.rules.push(...parseIgnoreFile(fs.readFileSync(p, "utf8")));
      }
    }
  }

  /**
   * relPath uses forward slashes. Directories that match are pruned by the
   * walker, so dir-only patterns only need to match the directory itself.
   * Unanchored patterns match against the basename (gitignore semantics).
   */
  isIgnored(relPath: string, isDir: boolean): boolean {
    const basename = relPath.split("/").pop() ?? relPath;
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      const hit = rule.anchored ? rule.regex.test(relPath) : rule.regex.test(basename);
      if (hit) ignored = !rule.negate;
    }
    return ignored;
  }

  /** Returns sorted list of indexable files, root-relative, forward slashes. */
  walk(): string[] {
    const out: string[] = [];
    const visit = (dir: string, rel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
          if (this.isIgnored(childRel, true)) continue;
          visit(path.join(dir, entry.name), childRel);
        } else if (entry.isFile()) {
          if (!INDEXABLE_EXTENSIONS.has(path.extname(entry.name))) continue;
          if (this.isIgnored(childRel, false)) continue;
          out.push(childRel);
        }
      }
    };
    visit(this.rootDir, "");
    return out.sort();
  }
}
