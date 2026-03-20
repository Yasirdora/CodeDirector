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

export interface BuildOptions {
  /** Persist the result to .codedirector/index.json (default true). */
  persist?: boolean;
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

  const walker = new RepoWalker(rootDir);
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

  // Lazily init the parser only if something actually needs parsing.
  let parserReady = false;

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
      next.files[relPath] = prev;
      unchanged++;
      continue;
    }
    if (!parserReady) {
      await parser.init();
      parserReady = true;
    }
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
