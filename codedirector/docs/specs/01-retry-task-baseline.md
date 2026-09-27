# Spec 01 — Retry must not re-baseline (finding #1)

Status: approved 2026-09-27 · implement with 05 + 03 as one arc.

## Problem

Every `cdir run` captures a fresh KEEP baseline (`src/run/run.ts:227-234` →
`captureBaseline`; signatures are read from the current tree,
`src/run/baseline.ts:158-166`). A broken protected signature fails attempt 1,
but attempt 2 captures the *broken* state as truth: exit 0, "signature
unchanged", lock status flipped to `verified`. Agents retry by default, so
this is the normal path, not an edge case. There is no attempt/task concept
anywhere (`grep -r attempt src/` is empty); only `draft`/`abandoned` locks are
refused a run (`src/run/run.ts:205-210`), and `test/run.test.ts:329` currently
pins "retries stay allowed".

## Reproduction (verified on snapshot; mechanism unchanged at HEAD)

1. Repo with `src/pipeline.ts` containing `export function render(a: string, b: string): string`.
   Lock with `keep: [{kind: api-unchanged, symbols: ["src/pipeline.ts#render"]}]`,
   `budget.files: ["src/pipeline.ts"]`; `lock check` + `lock activate`.
2. `cdir run IL-0001 -- node -e '<add a third parameter to render>'`
   → exit 1, FAILED, `✗ KEEP api-unchanged: signature changed`.
3. `cdir run IL-0001 -- node -e ""`
   → exit 0, `✓ api-unchanged: signature unchanged`, verdict VERIFIED.
4. Evidence: two baseline files, two different signature sha256s, each "held"
   in its own run. The second run also reports `0 file(s) changed` — the break
   has become "pre-existing dirt".

## Required behavior

- A Lock has one **task baseline**, captured once — on the first run, or by an
  explicit task-start command (see Spec 03, direct-edit flow). It is immutable.
- Every attempt is judged **cumulatively against the task baseline**, never
  against its own start state. Attempt N's report lists all files changed
  since the task baseline and compares all KEEP clauses to it.
- Re-running after failure is allowed and stays failed until the break is
  *fixed* — fixing it turns the check held again (that is the baseline's job).
- Rebaselining is an explicit, logged **contract revision** requiring
  re-approval, and the report says the reference moved.
- Pre-existing dirt captured before the task baseline stays excluded.

## Design sketch

- New artifact `.codedirector/baselines/IL-XXXX-task.json`, immutable after
  capture; its sha256 is recorded in every attempt and re-checked there (reuse
  the existing tamper-evident baseline hash).
- `RunRecord` gains `attemptId` and `taskBaselinePath`; classification diffs
  the current tree against the task baseline (`classifyChanges` already takes
  an arbitrary baseline — this is mostly plumbing).
- Verdict per attempt: violations are computed against the task baseline, so
  attempt N is never greener than the tree actually is.
- **Legacy locks** (baselines predating this change) must not silently adopt
  the present tree: the first run under new code either derives the task
  baseline from the lock's first recorded baseline file, or refuses with
  "run `cdir lock rebase --accept-current` to adopt the present tree". Silent
  adoption is the bug being fixed.
- CLI verb: `cdir lock rebase <id>` (records the revision; requires
  `lock check` + `lock activate` to re-seal). Exact verb/flag ride with the
  arc's CLI pass.

## Tests / acceptance

- T1: fail → retry no-op → still failed, same violation, attempt 2 named.
- T2: fix the break → next attempt holds.
- T3: pre-existing dirt still not billed.
- T4: rebase requires re-approval and is visible in report/audit trail.
- T5: direct-edit flow (Spec 03) judges current tree vs task baseline.
- New eval cases mirroring T1 and T5 (violation substrings + status).
- Done = the reproduction above no longer yields VERIFIED; `test/run.test.ts:329`
  is updated to encode the new semantics.

## Open decisions

- Does a failed attempt keep the lock's single status field, or does the lock
  grow an attempt list (recommend: status stays, attempts are the run records)?
- Whether rebase lives on `lock` or as a top-level `cdir rebase`.
