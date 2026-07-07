/**
 * Verification engine types (blueprint §17): every claim the system makes
 * carries exactly one evidence class, and the Unchecked bucket is always
 * named, never silently empty.
 *
 * Evidence classes:
 *  - measured:   observed differentially, pre and post, same harness
 *                (test runs, output hashes, verifyCommand)
 *  - proven:     structurally guaranteed, no execution needed
 *                (signature hash match, manifest diff, clean typecheck)
 *  - asserted:   claimed without a differential check; a claim without an
 *                artifact reference is automatically Asserted (enforced in
 *                code by enforceArtifactRule, not by discipline)
 *  - unchecked:  no check exists or none could run — named, with the reason
 */

import { KeepClauseKind } from "../lock/types";

export type EvidenceClass = "measured" | "proven" | "asserted" | "unchecked";

export const EVIDENCE_CLASSES: EvidenceClass[] = ["proven", "measured", "asserted", "unchecked"];

/** held = the claim was checked and held · violated = checked and broken · unchecked = no check ran */
export type Verdict = "held" | "violated" | "unchecked";

export type VerificationSource = "keep-clause" | "typecheck" | "verify-command";

export interface VerificationItem {
  source: VerificationSource;
  /** Present when source is "keep-clause". */
  clauseKind?: KeepClauseKind;
  /** Short label, e.g. "api-unchanged · src/util.js#add". */
  subject: string;
  verdict: Verdict;
  evidenceClass: EvidenceClass;
  /** What was found (e.g. "signature changed: src/util.js#add"). */
  detail: string;
  /**
   * Pointer to the evidence: which baseline file, which command, which exit
   * code. A held claim without an artifactRef is downgraded to Asserted by
   * enforceArtifactRule — schema-enforced, not voluntary.
   */
  artifactRef?: string;
  /** Why the claim is unchecked (required when verdict is "unchecked"). */
  reason?: string;
}

export interface VerificationReport {
  lockId: string;
  verifiedAt: string;
  /** Baseline the differential checks ran against (repo-relative), if any. */
  baselinePath?: string;
  /** True when the baseline file's hash no longer matches the run record. */
  baselineTampered?: boolean;
  items: VerificationItem[];
  /** "KEEP <kind>: <detail>" / "VERIFY <source>: <detail>" for every violated item. */
  violations: string[];
  /** Items per evidence class (all four keys always present). */
  counts: Record<EvidenceClass, number>;
}

export function countByClass(items: VerificationItem[]): Record<EvidenceClass, number> {
  const counts: Record<EvidenceClass, number> = { proven: 0, measured: 0, asserted: 0, unchecked: 0 };
  for (const item of items) counts[item.evidenceClass]++;
  return counts;
}

/**
 * The schema law from blueprint §14/§22: a claim without an artifact
 * reference is automatically Asserted. Applied to every report before
 * rendering; violations keep their class (a broken check IS the artifact,
 * recorded in detail), only "held" claims can be downgraded.
 */
export function enforceArtifactRule(items: VerificationItem[]): VerificationItem[] {
  return items.map((item) => {
    if (
      item.verdict === "held" &&
      (item.evidenceClass === "proven" || item.evidenceClass === "measured") &&
      !item.artifactRef
    ) {
      return {
        ...item,
        evidenceClass: "asserted",
        detail: `${item.detail} (no artifact reference — downgraded to Asserted by schema rule)`,
      };
    }
    return item;
  });
}
