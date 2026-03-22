/**
 * Public API surface for later Code Director stages (Intent Lock, scope
 * enforcement, checkpoint/undo, Change Report, eval harness).
 *
 * Stage-2+ code should import from here, not reach into core internals:
 *
 *   import { buildIndex, loadIndex, buildGraph, rankSymbols, blastRadius } from "codedirector";
 */

export {
  INDEX_SCHEMA_VERSION,
  type SymbolKind,
  type SymbolInfo,
  type ImportInfo,
  type CallSite,
  type FileIndex,
  type RepoIndex,
  type CallEdge,
  type BuildStats,
} from "./core/types";

export { RepoWalker, INDEXABLE_EXTENSIONS } from "./core/walk";
export { StructuralParser, langForFile, type LangKey } from "./core/parser";
export { buildIndex, hashContent, type BuildOptions, type BuildResult } from "./core/builder";
export { loadIndex, saveIndex, indexPath, indexDir, stableStringify, emptyIndex } from "./core/store";

export {
  buildGraph,
  resolveModule,
  directCallers,
  directCallees,
  transitiveCallers,
  testFilesFor,
  isTestFile,
  type SymbolGraph,
  type TransitiveCallers,
} from "./core/graph";

export {
  rankSymbols,
  PAGERANK_DAMPING,
  PAGERANK_ITERATIONS,
  type RankedSymbol,
} from "./core/rank";

export {
  buildRepoMap,
  formatRepoMap,
  resolveAnchors,
  estimateTokens,
  type RepoMapResult,
  type MapOptions,
} from "./core/map";

export {
  blastRadius,
  findSymbols,
  formatBlastRadius,
  MAX_TRANSITIVE_DEPTH,
  type BlastRadiusReport,
} from "./core/why";

export { coChange, isGitRepo, type CoChangeResult } from "./core/git";
