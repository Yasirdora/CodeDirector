/**
 * The domain contract (ADR 0001).
 *
 * A domain is ecosystem knowledge — Node/TypeScript, Apple — that the core
 * consults and never contains. Its capabilities are independent: a domain
 * registers only what it actually knows, and each capability is consulted at
 * its own lifecycle stage (indexing, drafting, baseline, verification).
 *
 * The line this file draws:
 *
 *   domains STATE FACTS and DESCRIBE CHECKS;
 *   the core OWNS ALGORITHMS AND EXECUTION.
 *
 * So nothing below runs a process, ranks a symbol, walks a graph or assigns
 * an evidence class. A check is described as data (what to run, how to read
 * its output); the core runs it — isolated, under a timeout, differentially
 * against the baseline — and decides what the result is worth. A domain
 * that wants a different algorithm contributes facts to the shared one.
 *
 * Core types are imported one way only: domains may depend on the core, the
 * core never depends on a domain (enforced by test/domains.test.ts).
 */

import type { FactProvenance, FactSource } from "../core/provenance";
import type { KeepClause } from "../lock/types";

// ---------------------------------------------------------------------
// projectFacts — what kind of project this is (drafting)

/** One fact about the project's shape, e.g. "there is a SwiftPM package at the root". */
export interface ProjectFact {
  /** Domain-defined kind, e.g. "swiftpm-package". */
  kind: string;
  /** Root-relative path the fact was read from. */
  path: string;
  provenance: FactProvenance;
}

export interface ProjectFactsProvider {
  /** Read-only detection: file-system facts only, nothing executed. */
  detect(rootDir: string): ProjectFact[];
}

// ---------------------------------------------------------------------
// graphFacts — relationships the shared graph algorithms consume (indexing)

export interface ImportResolution {
  /** Root-relative path of the file the import names. */
  target: string;
  /** Where the resolution came from (default "tree-sitter"). */
  source?: FactSource;
}

export interface GraphFactsProvider {
  /**
   * Resolve an import, as written in `fromFile`, to an indexed file — or
   * null when this domain does not recognise it. `hasFile` answers whether a
   * root-relative path is in the index. The core tries each domain in
   * registration order and keeps the first answer.
   */
  resolveImport(fromFile: string, specifier: string, hasFile: (relPath: string) => boolean): ImportResolution | null;
}

// ---------------------------------------------------------------------
// testMapping — which files are tests (indexing, drafting, reporting)

export interface TestMappingProvider {
  /** Whether a root-relative path is a test file by this ecosystem's conventions. */
  isTestFile(relPath: string): boolean;
  /**
   * Compress this domain's test files into deny globs for a draft, e.g.
   * `src/**\/*.test.*`. Optional; without it the files are listed singly.
   */
  compressTestPaths?(testFiles: string[]): string[];
}

// ---------------------------------------------------------------------
// dependencyFacts — manifests whose change means a dependency change (baseline)

export interface DependencyManifest {
  /** Root-relative path, e.g. "package.json". */
  path: string;
  /**
   * What of the manifest counts as its dependencies, as a stable string.
   * Absent: the whole file's content hash counts.
   */
  fingerprint?(raw: string): string;
}

export interface DependencyFactsProvider {
  manifests: DependencyManifest[];
}

// ---------------------------------------------------------------------
// checkProviders — checks described as data; the core executes them

/** How to invoke a check. The core decides isolation, timeout and environment. */
export type CheckInvocation = { argv: string[] } | { shell: string };

/**
 * What a diagnostics check would do right now, decided from file-system
 * facts alone (no execution).
 */
export type DiagnosticsPlan =
  | {
      kind: "not-applicable";
      /** Named in the report's Unchecked bucket, e.g. "no tsconfig.json — typecheck rung skipped". */
      reason: string;
    }
  | {
      kind: "run";
      run: CheckInvocation;
      /** The invocation as the report names it (artifact reference). */
      how: string;
      /**
       * When set, any failure to run — spawn error, timeout, or output
       * matching `unavailableOutput` — is reported as unavailable with this
       * single reason. Unset: the core words timeouts and spawn errors itself.
       */
      unavailableReason?: string;
      unavailableOutput?: RegExp;
    };

/** One compiler diagnostic, keyed without its position so moved lines compare equal. */
export interface Diagnostic {
  key: string;
  /** The original line, for display. */
  line: string;
}

/**
 * A compiler-diagnostics check (e.g. `tsc --noEmit`). The core runs it
 * before and after the change and judges only the diagnostics the change
 * added.
 */
export interface DiagnosticsCheck {
  /** Stable id, also the key of this check's diagnostics in a baseline. */
  id: string;
  /** Report subject, e.g. "typecheck · tsc --noEmit". */
  subject: string;
  /** Short name used in details, e.g. "tsc --noEmit". */
  label: string;
  /** The executable's name in "<tool> could not run" reasons, e.g. "tsc". */
  tool: string;
  /** Default timeout in ms, when the caller gives none. */
  defaultTimeoutMs: number;
  plan(rootDir: string): DiagnosticsPlan;
  /** Diagnostics from the check's stdout. */
  parse(stdout: string): Diagnostic[];
  /** Whether an output line is an error line, for a short excerpt when nothing parses. */
  isErrorLine(line: string): boolean;
  /**
   * The baseline field an older release stored this check's diagnostics
   * under, so a baseline captured before the domain split is still read.
   */
  legacyBaselineField?: string;
}

/**
 * The runner behind the `tests-pass` KEEP clause. At most one is registered:
 * the clause names no runner, so two would make its meaning ambiguous.
 */
export interface TestRunnerDescription {
  id: string;
  /** How reports name the runner, e.g. "node --test". */
  label: string;
  /** What it measures, e.g. "JavaScript/TypeScript" — used when it refuses files. */
  covers: string;
  /** Whether the runner can execute this test file at all. */
  acceptsFile(relPath: string): boolean;
  /** Argv that runs exactly these files. */
  argv(files: string[]): string[];
  /** Names of failing tests read from the runner's output (a few are enough). */
  failures(output: string): string[];
}

/** A toolchain a verify command can name, and the languages running it exercises. */
export interface ToolchainReach {
  name: string;
  pattern: RegExp;
  /** Language names as `languageOf` produces them ("Swift", "TypeScript", …). */
  languages: string[];
}

export interface CheckProviders {
  diagnostics?: DiagnosticsCheck[];
  testRunner?: TestRunnerDescription;
  /** What a verifyCommand reaches when it names one of these toolchains. */
  toolchains?: ToolchainReach[];
}

// ---------------------------------------------------------------------
// changeClassifiers — what kind of change a diff is (reporting; no consumer yet)

/**
 * The core's risk vocabulary. Domains detect; the core owns the words, so
 * policy can act on a category without knowing any ecosystem.
 */
export type ChangeCategory =
  | "cosmetic"
  | "local-behavior"
  | "api-surface"
  | "concurrency"
  | "persistence"
  | "dependency"
  | "build-configuration";

export interface ChangeClassification {
  category: ChangeCategory;
  /** The domain's own, more specific name, e.g. "actor-isolation-change". */
  tag: string;
  detail: string;
  provenance: FactProvenance;
}

export interface ChangedFile {
  path: string;
  /** Content before the change; absent for a new file. */
  before?: string;
  /** Content after the change; absent for a deleted file. */
  after?: string;
}

/**
 * Registered now so the seam exists; nothing consumes classifications yet.
 * When something does, a classification may only ADD verification — never
 * remove a check the sealed lock promised (ADR 0001).
 */
export interface ChangeClassifier {
  id: string;
  classify(change: ChangedFile): ChangeClassification[];
}

// ---------------------------------------------------------------------
// profileRules — named draft presets (drafting)

/** What a profile contributes to a draft. The core merges it with explicit flags. */
export interface ProfileDefaults {
  deny?: string[];
  keep?: KeepClause[];
  verifyCommand?: string;
  verifyTimeoutMs?: number;
}

export interface ProfileRule {
  /** `--profile <name>`. Unique across registered domains. */
  name: string;
  /** One sentence after the quoted name in the MCP tool description. */
  summary: string;
  /** Defaults for a project with these facts (every domain's facts, not only this one's). */
  defaults(facts: ProjectFact[]): ProfileDefaults;
  /** Also deny what this domain's generatedPathRules say is generated here. */
  denyGeneratedPaths?: boolean;
}

// ---------------------------------------------------------------------
// generatedPathRules — what is never source, and what a tool generates

export interface GeneratedByMarker {
  /** Root-relative files whose presence means the paths are generated. */
  markers: string[];
  /** Globs of the generated paths. */
  paths: string[];
  reason: string;
}

export interface GeneratedPathRules {
  /** Directory names the index never walks into (build products, vendored code). */
  neverSourceDirs?: string[];
  /** Paths a generator owns when its marker is present — never hand-edited. */
  generatedByMarker?: GeneratedByMarker[];
}

// ---------------------------------------------------------------------

export interface Domain {
  /** Stable id, e.g. "node", "apple". */
  id: string;
  description: string;
  projectFacts?: ProjectFactsProvider;
  graphFacts?: GraphFactsProvider;
  testMapping?: TestMappingProvider;
  dependencyFacts?: DependencyFactsProvider;
  checkProviders?: CheckProviders;
  changeClassifiers?: ChangeClassifier[];
  profileRules?: ProfileRule[];
  generatedPathRules?: GeneratedPathRules;
}
