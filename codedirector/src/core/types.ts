/**
 * Core data model for the Code Director structural index.
 *
 * Everything here is plain JSON-serializable data. The persisted index
 * (.codedirector/index.json) is a RepoIndex; derived structures (resolved
 * call edges, rankings, blast-radius reports) are computed from it and never
 * stored, so a partially re-built index can never leave stale derived state
 * behind.
 */

import type { FactProvenance } from "./provenance";

export const INDEX_SCHEMA_VERSION = 1;

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "const"
  | "enum";

export interface SymbolInfo {
  /** Stable identity: "<relpath>#<qualifiedName>" (methods: "File#Class.method"). */
  id: string;
  /** Bare name, e.g. "render". */
  name: string;
  /** Qualified name within the file, e.g. "ImagePipeline.render". */
  qualifiedName: string;
  kind: SymbolKind;
  /** File path relative to the indexed root, forward slashes. */
  file: string;
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  exported: boolean;
  /** One-line signature (no body), whitespace-collapsed. */
  signature: string;
}

export interface ImportInfo {
  /** Module specifier as written, e.g. "./pipeline" or "node:crypto". */
  module: string;
  /** Imported names: named imports, default ("default"), namespace ("*"). */
  names: string[];
  line: number;
}

/** A raw, unresolved call site observed in a file. */
export interface CallSite {
  /** Id of the enclosing symbol ("<file>#<qualifiedName>"), or "<file>#<toplevel>". */
  callerId: string;
  /** Callee as written: identifier name, or property name for method calls. */
  calleeName: string;
  /** True for obj.method() style calls (resolution is best-effort). */
  isMethod: boolean;
  line: number;
}

export interface FileIndex {
  /** sha256 of file contents, hex. Drives incremental re-indexing. */
  hash: string;
  /** Extraction logic version; mismatch with PARSER_VERSION forces reparse. */
  parserVersion: number;
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  calls: CallSite[];
}

export interface RepoIndex {
  schemaVersion: number;
  /** ISO timestamp of the last build (informational only). */
  updatedAt: string;
  /** Keyed by root-relative file path, forward slashes. Sorted on write. */
  files: Record<string, FileIndex>;
}

/** A call edge resolved against the symbol table. */
export interface CallEdge {
  fromId: string;
  toId: string;
  /** How the edge was first resolved (the syntactic resolution step that found it). */
  resolution: "same-file" | "import" | "unique-name" | "method-name";
  /**
   * Every source that established this edge, strongest first. One entry
   * today; a compiler-backed source adds its own entry beside the syntactic
   * one rather than replacing it (see core/provenance.ts).
   */
  provenance: FactProvenance[];
}

export interface BuildStats {
  filesTotal: number;
  filesParsed: number;
  filesUnchanged: number;
  filesRemoved: number;
  durationMs: number;
}
