/**
 * Public API surface for later Code Director stages (Vibe Check, scope
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
  resolveAnchorsDetailed,
  estimateTokens,
  type RepoMapResult,
  type MapOptions,
  type AnchorStrength,
  type AnchorResolution,
} from "./core/map";

export {
  blastRadius,
  findSymbols,
  formatBlastRadius,
  MAX_TRANSITIVE_DEPTH,
  type BlastRadiusReport,
} from "./core/why";

export { coChange, isGitRepo, type CoChangeResult } from "./core/git";

// Stage 2 — Vibe Check
export {
  LOCK_SCHEMA_VERSION,
  DEPENDENCY_MANIFESTS,
  clauseCheckability,
  CHECKABILITY_MARK,
  type LockStatus,
  type KeepClauseKind,
  type KeepClause,
  type LockBudget,
  type LockAssumption,
  type VibeCheck,
  type ClauseCheckability,
} from "./lock/types";
export { lockToYaml, lockFromYaml, LockParseError } from "./lock/yaml";
export { globToRegExp, matchPath, validateGlob, hasGlobChars } from "./lock/glob";
export {
  locksDir,
  nextLockId,
  loadLock,
  listLocks,
  saveLock,
  lockPathFor,
  slugify,
} from "./lock/store";
export { draftLock, parseKeepClause, type DraftOptions, type DraftResult } from "./lock/draft";
export {
  checkLock,
  signatureHash,
  type LockCheckResult,
  type ClauseCheck,
} from "./lock/check";
export { formatLock, formatLockLine } from "./lock/show";

// Stage 2 — checkpoint / undo
export {
  createCheckpoint,
  latestCheckpoint,
  undo,
  dirtyPaths,
  porcelainLinePaths,
  gitStatusPorcelain,
  gitPrefix,
  toRootRelative,
  workTreeStatusPorcelain,
  checkpointsPath,
  CheckpointError,
  type Checkpoint,
  type UndoRecord,
  type UndoResult,
  type UndoOptions,
} from "./checkpoint";

// Stage 2 — baseline + scope enforcement + run wrapper
export {
  captureBaseline,
  saveBaseline,
  loadBaseline,
  latestBaselinePath,
  baselinesDir,
  type Baseline,
  type BaselineOutput,
  type BaselineOptions,
} from "./run/baseline";
export { runShellProbe, runArgvProbe, sha256, type ProbeResult } from "./run/probe";
export {
  classifyChanges,
  classifyPath,
  changedFiles,
  changedLineCount,
  type ChangeClass,
  type ClassifiedChange,
} from "./run/classify";
export {
  runWithLock,
  formatRunReport,
  runsDir,
  RunError,
  type RunRecord,
  type RunOutcome,
  type RunOptions,
  type KeepResult,
  type BudgetStats,
} from "./run/run";

// Stage 3 — verification engine (evidence classes are the product)
export {
  EVIDENCE_CLASSES,
  countByClass,
  enforceArtifactRule,
  type EvidenceClass,
  type Verdict,
  type VerificationSource,
  type VerificationItem,
  type VerificationReport,
} from "./verify/types";
export { verifyLock, verifyWithBaseline, VerifyError, type VerifyOptions } from "./verify/verify";

// Stage 3 — Change Report
export {
  buildReport,
  latestRunRecord,
  finalizeLockStatus,
  ReportError,
  type ChangeReport,
  type Finding,
  type BuildReportOptions,
} from "./report/report";
export { formatReport, formatReportMarkdown, formatReportJson, summarizeReport } from "./report/format";
export { startMcpServer } from "./mcp/server";
