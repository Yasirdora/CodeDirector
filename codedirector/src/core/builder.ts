/**
 * Incremental structural index builder.
 *
 * Each file's content hash (sha256) is stored in the index. On rebuild,
 * only files whose hash changed (or that are new) are reparsed; removed
 * files are dropped. BuildStats.filesParsed is the authoritative reparse
 * counter — tests assert incrementality through it, not through timing.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StructuralParser, PARSER_VERSION } from "./parser";
import { emptyIndex, loadIndex, saveIndex } from "./store";
import { BuildStats, FileIndex, RepoIndex } from "./types";
import { RepoWalker } from "./walk";
import type { DomainRegistry } from "../domain/registry";

export interface BuildOptions {
  /** Persist the result to .codedirector/index.json (default true). */
  persist?: boolean;
  /** Domains whose never-source directories the walk skips (default: the built-in ones). */
  domains?: DomainRegistry;
}

export interface BuildResult {
  index: RepoIndex;
  stats: BuildStats;
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export async function buildIndex(rootDir: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const started = Date.now();
  const persist = opts.persist !== false;

  const walker = new RepoWalker(rootDir, opts.domains);
  const files = walker.walk();

  const previous = loadIndex(rootDir) ?? emptyIndex();
  const next: RepoIndex = {
    schemaVersion: previous.schemaVersion,
    updatedAt: new Date().toISOString(),
    files: {},
  };

  const parser = new StructuralParser();
  let parsed = 0;
  let unchanged = 0;

  // First decide what needs parsing, so the parser knows the work ahead
  // (it picks its WebAssembly tier from it) and is only started if needed.
  // Only paths are kept: a first index of a large repo would otherwise hold
  // every file's text at once.
  const toParse = new Set<string>();
  const keep = new Set<string>();
  for (const relPath of files) {
    const abs = path.join(rootDir, relPath);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue; // unreadable file — skip
    }
    const hash = hashContent(content);
    const prev = previous.files[relPath];
    if (prev && prev.hash === hash && prev.parserVersion === PARSER_VERSION) {
      keep.add(relPath);
      continue;
    }
    toParse.add(relPath);
  }
  if (toParse.size > 0) await parser.init([...toParse]);

  for (const relPath of files) {
    if (keep.has(relPath)) {
      next.files[relPath] = previous.files[relPath];
      unchanged++;
      continue;
    }
    if (!toParse.has(relPath)) continue; // unreadable — skipped, as before
    let content: string;
    try {
      content = fs.readFileSync(path.join(rootDir, relPath), "utf8");
    } catch {
      continue; // vanished since the first pass — skipped, as unreadable
    }
    const hash = hashContent(content);
    let fileIndex: FileIndex;
    try {
      fileIndex = parser.parseFile(relPath, content, hash);
    } catch {
      // A file that fails to parse keeps an empty entry so the hash is
      // still tracked (no reparsing churn on broken intermediate states).
      fileIndex = { hash, parserVersion: PARSER_VERSION, symbols: [], imports: [], calls: [] };
    }
    next.files[relPath] = fileIndex;
    parsed++;
  }

  const removed = Object.keys(previous.files).filter((f) => !files.includes(f)).length;

  if (persist) saveIndex(rootDir, next);

  return {
    index: next,
    stats: {
      filesTotal: files.length,
      filesParsed: parsed,
      filesUnchanged: unchanged,
      filesRemoved: removed,
      durationMs: Date.now() - started,
    },
  };
}
