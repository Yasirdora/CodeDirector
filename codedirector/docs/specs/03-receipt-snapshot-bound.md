# Spec 03 — The receipt must be bound to a snapshot; fresh verification computes a fresh delta (finding #3)

Status: approved 2026-09-27 · implement with 05 + 01 as one arc.

## Problem

`report` re-runs the ladder (`src/report/report.ts:185`) but takes `changed`
from the stored run record — `rejudgeRun` only re-classifies recorded paths
(`src/run/classify.ts:243-259`; `report.ts:201,235`). `verify` re-judges
nothing scope-wise at all. Changes made *after* the run are invisible to the
receipt. The direct-edit workflow the skill prescribes
(`skills/codedirector/SKILL.md:43-44`: checkpoint → edit → verify) captures no
KEEP baseline and no delta: verify falls back to `latestBaselinePath` or
nothing (`src/verify/verify.ts:536-546`).

## Reproduction (both verified)

1. Clean verified run on `src/pipeline.ts`; then directly rewrite denied
   `src/secret.ts`. `cdir report IL-0001` and `cdir verify IL-0001` both say
   VERIFIED and list only `src/pipeline.ts`.
2. Direct-edit variant: `cdir checkpoint`; edit a protected signature and the
   denied file; `cdir verify IL-0002` → VERIFIED, "Changed files: (no run
   record — verification only)", `Checks: none ran`, api-unchanged merely
   Unchecked.

## Required behavior

- **Historical reporting is read-only over a named attempt.** `cdir report
  <lock> [--attempt N]` renders that attempt's stored results and labels the
  source snapshot (attempt id, baseline path, timestamp). It never implies
  "this is the current tree".
- **Current verification computes a fresh full delta.** `cdir verify`
  classifies the *current tree* against the task baseline — every changed
  file, budget, deny, line counts — then runs the ladder. With a task baseline
  captured at task start, `verify` is a complete receipt for the direct-edit
  flow.
- **Direct edits get a supported path.** Ship a task-start verb (e.g.
  `cdir checkpoint IL-XXXX` or `cdir begin IL-XXXX`) that captures the task
  baseline and the git checkpoint together; update skill/integrations to use
  it. Editing without it → `verify` says "no task baseline for this lock —
  scope could not be judged" (warn + `incomplete`), never VERIFIED.
- Scope-delta computation is the same code path as run-time classification
  (one implementation, two callers) so the two can never drift.

## Design sketch

- Depends on Spec 01's task baseline. `rejudgeRun` keeps its purpose
  (re-judge an old attempt against an edited lock) but stops being the source
  of truth for current status.
- `verify` gains: fresh `classifyChanges(root, lock, taskBaseline)` plus line
  counting, feeding a report whose `changed`/`budget` are current, labeled
  "current tree vs task baseline".
- `report` distinguishes `--attempt N` (historical, stored evidence) from the
  current-tree view; the summary line states which snapshot the verdict
  belongs to.

## Tests / acceptance

- The two reproductions become tests: post-run denied edit caught by `verify`;
  direct-edit with task baseline produces a full delta and a failure when a
  denied file moved.
- Update `test/report.test.ts:286-297` (currently pins "no run record —
  verification only" as acceptable) to assert the warning/refusal instead.
- Eval case: checkpoint-with-lock → edit denied file → `verify` → FAILED.
- Done = both reproductions no longer yield VERIFIED.

## Open decisions

- `report` default: historical attempt (recommended) vs current-tree view;
  either way the label is mandatory.
- `verify` without a task baseline: warn + `incomplete` (recommended) vs hard
  fail.
