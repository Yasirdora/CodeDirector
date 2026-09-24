/**
 * Vibe Check data model (schema v1).
 *
 * A Lock is a compiled, enforceable contract: every KEEP clause is either
 * machine-checkable now, deferred to a later stage (stored, executed by the
 * verification runner), or explicitly `custom` (admissible, but always
 * reported as unchecked by design — the human judges).
 *
 * Locks are human-readable YAML files versioned in-repo at
 * .codedirector/locks/IL-<NNNN>-<slug>.yaml. The utterance is immutable
 * after creation; everything else is editable while status is draft.
 */

export const LOCK_SCHEMA_VERSION = 1;

export type LockStatus = "draft" | "active" | "verified" | "failed" | "abandoned";

export const LOCK_STATUSES: LockStatus[] = ["draft", "active", "verified", "failed", "abandoned"];

export type KeepClauseKind =
  | "output-unchanged"
  | "api-unchanged"
  | "no-new-dependency"
  | "tests-pass"
  | "custom";

export const KEEP_CLAUSE_KINDS: KeepClauseKind[] = [
  "output-unchanged",
  "api-unchanged",
  "no-new-dependency",
  "tests-pass",
  "custom",
];

/**
 * A KEEP clause. Which optional fields are meaningful depends on `kind`:
 *  - output-unchanged:  command + fixtures (differential: sha256 of stdout,
 *                       captured at baseline time and re-run at verify time)
 *  - api-unchanged:     symbols (symbol ids; signature hash, structural)
 *  - no-new-dependency: (no payload; manifest/lockfile sha256 diff)
 *  - tests-pass:        glob (test glob; executed via `node --test`)
 *  - custom:            text (free text; never machine-checkable)
 */
export interface KeepClause {
  kind: KeepClauseKind;
  /** output-unchanged: the entry command to run. */
  command?: string;
  /** output-unchanged: fixture paths or globs fed to the command. */
  fixtures?: string[];
  /** api-unchanged: symbol ids ("<relpath>#<qualifiedName>"). */
  symbols?: string[];
  /** tests-pass: glob selecting the test files that must keep passing. */
  glob?: string;
  /** custom: the free-text clause. */
  text?: string;
}

export interface LockBudget {
  /** Files (or globs) the change may touch. */
  files: string[];
  /** Symbols the change may modify (advisory in v1; file-level enforced). */
  symbols: string[];
  maxFiles: number;
  maxLines: number;
}

export interface LockAssumption {
  text: string;
  source: "user" | "system";
  confirmed: boolean;
}

export interface VibeCheck {
  schemaVersion: number;
  /** "IL-NNNN" */
  id: string;
  status: LockStatus;
  /** The user's exact words. Immutable after creation. */
  utterance: string;
  goal: string;
  /** The system's operationalization of the goal. Editable. */
  interpretation: string;
  keep: KeepClause[];
  /** Paths/globs the change must not touch. */
  deny: string[];
  /** One-line scope description. */
  change: string;
  /**
   * Optional user-specified verification harness (e.g. "npm test"), executed
   * by the verification ladder after the built-in checks; pass/fail is
   * measured evidence.
   */
  verifyCommand?: string;
  /**
   * Optional timeout (ms) for tests-pass runs and verifyCommand — long Apple
   * test suites need more than the 60s default. CLI --test-timeout overrides.
   */
  verifyTimeoutMs?: number;
  /**
   * Languages the human asserts `verifyCommand` exercises, for when its
   * reach cannot be read from its text — an npm script that shells out to
   * swift, a Makefile target, any bespoke harness. Names are the ones
   * `languageOf` produces ("Swift", "TypeScript", …).
   *
   * The escape hatch for the coverage check, and a claim the human owns:
   * nothing here verifies that the command does what this says it does.
   */
  verifyCovers?: string[];
  budget: LockBudget;
  /** Acceptance signals (text in v1). */
  accept: string[];
  assumptions: LockAssumption[];
  createdAt: string;
  createdBy: string;
}

/**
 * Checkability of a KEEP clause — drives the markers in `cdir lock show`:
 *  - "now":      ✓ machine-checkable (structural diff or executed check)
 *  - "deferred": stored now, executed by a later-stage runner (unused since
 *                the verification engine landed; kept for schema stability)
 *  - "custom":   ? not machine-checkable — human judges
 */
export type ClauseCheckability = "now" | "deferred" | "custom";

export function clauseCheckability(clause: KeepClause): ClauseCheckability {
  switch (clause.kind) {
    case "api-unchanged":
    case "no-new-dependency":
    case "output-unchanged":
    case "tests-pass":
      return "now";
    case "custom":
      return "custom";
  }
}

export const CHECKABILITY_MARK: Record<ClauseCheckability, string> = {
  now: "✓",
  deferred: "~",
  custom: "?",
};

/**
 * Test files `node --test` can run: JavaScript, and TypeScript through type
 * stripping. A tests-pass glob that reaches anything else (a Swift, Python or
 * JSX file) cannot be measured by this clause — node reads it as a script,
 * fails, and the clause used to report a passing suite as failing (a Swift
 * test file, reproduced on 0.4.5). Such suites belong in verifyCommand.
 */
export const NODE_TEST_FILE = /\.(?:[cm]?js|[cm]?ts)$/;

/** Dependency manifests / lockfiles hashed for no-new-dependency checks. */
export const DEPENDENCY_MANIFESTS = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Package.swift",
  "Package.resolved",
  "Podfile",
  "Podfile.lock",
  "Cartfile",
  "Cartfile.resolved",
];
