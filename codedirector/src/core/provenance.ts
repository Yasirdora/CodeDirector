/**
 * Provenance of a fact: where it came from, how strong it is, and whether
 * it still describes the tree in front of us.
 *
 * Every relationship the graph holds carries one of these. Nothing here is
 * a numeric confidence — a number nobody calibrated would look like a
 * measurement and be none. A fact is instead labelled with its source and
 * with the same evidence vocabulary the verifier uses, so "the compiler
 * says so" and "one symbol in the repo has that name" can be told apart
 * and ranked without pretending to know by how much.
 *
 * The rules this module encodes (ADR 0001):
 *  - stronger evidence ranks above weaker evidence, but does not erase it;
 *  - a fact derived from a revision that no longer matches the file is
 *    stale, and a stale fact is not evidence at all.
 */

/**
 * Where a fact came from. The named values are the ones Code Director knows
 * about today or has planned; a domain may name its own.
 *
 *  - tree-sitter:   read from the syntax tree by the shared extractor
 *  - inferred:      a heuristic over syntax facts (e.g. "only one symbol
 *                   anywhere has this name")
 *  - typescript, sourcekit, indexstore: a compiler or its index
 *  - xcode-project, swiftpm: a build system's own project description
 *  - git:           repository history
 *  - file-system:   a file's presence or name (e.g. a manifest at the root)
 */
export type FactSource =
  | "tree-sitter"
  | "inferred"
  | "file-system"
  | "typescript"
  | "sourcekit"
  | "indexstore"
  | "xcode-project"
  | "swiftpm"
  | "git"
  | (string & {});

/**
 * How strong a fact is, in the verifier's own words (see verify/types.ts).
 * "unchecked" has no place here: a fact nobody established is not a fact.
 *
 *  - proven:   established by a tool that cannot be wrong about it on this
 *              revision (a compiler's resolved reference)
 *  - measured: observed by running something
 *  - asserted: read from syntax or inferred — plausible, not established
 */
export type FactEvidence = "proven" | "measured" | "asserted";

/** current: derived from the file as it is now. stale: from an older revision. */
export type Freshness = "current" | "stale";

export interface FactProvenance {
  source: FactSource;
  /** The domain that contributed the fact; "core" for the shared extractor and graph. */
  domain: string;
  evidence: FactEvidence;
  freshness: Freshness;
  /**
   * The content hash (or build revision) of the input the fact was derived
   * from, when the fact outlives the build that made it. Facts derived on
   * every index build from the current file need none.
   */
  revision?: string;
}

const EVIDENCE_RANK: Record<FactEvidence, number> = { proven: 3, measured: 2, asserted: 1 };

/**
 * Within one evidence class, what the fact rests on. Three evidence classes
 * cannot tell "the import resolves to this file" from "only one symbol in
 * the repo has that name" — both are asserted — and ranking them by name
 * put the guess first. A compiler outranks a build system's description,
 * which outranks syntax, which outranks history, which outranks a guess. A
 * source a domain names itself ranks as syntax: it read something, and no
 * more is known about it.
 */
const SOURCE_TIER: Record<string, number> = {
  typescript: 5,
  sourcekit: 5,
  indexstore: 5,
  "xcode-project": 4,
  swiftpm: 4,
  "tree-sitter": 3,
  "file-system": 3,
  git: 2,
  inferred: 1,
};
const DOMAIN_SOURCE_TIER = 3;

function sourceTier(source: FactSource): number {
  return SOURCE_TIER[source] ?? DOMAIN_SOURCE_TIER;
}

/**
 * Whether a fact derived from `revision` still describes a file whose
 * content hash is now `currentRevision`. A fact that records no revision was
 * derived from the current tree by construction.
 */
export function freshnessOf(revision: string | undefined, currentRevision: string | undefined): Freshness {
  if (revision === undefined) return "current";
  return revision === currentRevision ? "current" : "stale";
}

/** The evidence a fact still carries: none once it is stale. */
export function effectiveEvidence(p: FactProvenance): FactEvidence | null {
  return p.freshness === "stale" ? null : p.evidence;
}

/**
 * Order two provenances, strongest first: current before stale, then by
 * evidence, then by what the evidence rests on (SOURCE_TIER).
 * Deterministic ties by source and domain name. Ranking only — nothing is
 * dropped, so weaker facts stay visible below stronger ones.
 */
export function compareProvenance(a: FactProvenance, b: FactProvenance): number {
  const ea = effectiveEvidence(a);
  const eb = effectiveEvidence(b);
  const ra = ea === null ? 0 : EVIDENCE_RANK[ea];
  const rb = eb === null ? 0 : EVIDENCE_RANK[eb];
  if (ra !== rb) return rb - ra;
  const ta = sourceTier(a.source);
  const tb = sourceTier(b.source);
  if (ta !== tb) return tb - ta;
  return a.source.localeCompare(b.source) || a.domain.localeCompare(b.domain);
}

/** The strongest provenance of a fact, or null when it has none. */
export function strongestProvenance(ps: FactProvenance[]): FactProvenance | null {
  if (ps.length === 0) return null;
  return [...ps].sort(compareProvenance)[0];
}
