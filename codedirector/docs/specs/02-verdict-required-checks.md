# Spec 02 — "Verified" must not survive an unfinished required check; `accept` must be visible (finding #2)

Status: approved 2026-09-27 · implement last in the approved order.

## Problem

A declared check that cannot run — including the lock's own `verifyCommand`
timing out — becomes `unchecked` (`src/verify/verify.ts:360-363, 392-393`), and
only `violated` items produce violations (`:507-510`), so the verdict stays
`verified` (`src/report/report.ts:219-220`) and `cdir run` exits 0 with
"Done — verified." Separately, `accept[]` is stored and shown by `lock show`
(`src/lock/show.ts:69-72`) but never evaluated or rendered in run/verify/report.

## Reproduction (both verified)

1. Lock with `verifyCommand: node -e "setTimeout(()=>{},8000)"`,
   `verifyTimeoutMs: 1500`, no-op command:
   `cdir run IL-0001 --test-timeout 1500 -- node -e ""`
   → exit 0, "Done — verified", `? verifyCommand … timed out after 1500ms`
   sitting in the Unchecked bucket.
2. Lock with two `accept:` criteria, no-op run → VERIFIED; the criteria appear
   nowhere in the report, not even under Unchecked.

## Required behavior

- Any **declared** machine check that could not run (timeout, spawn failure,
  named tool missing) makes the attempt verdict **`incomplete`**, distinct from
  `failed` and `verified`. Exit code stays non-zero; the report says plainly
  "not verified — a required check did not run".
- **Circumstantial** Unchecked must keep allowing `verified`: a lock never
  promised `tsconfig.json` or a compiler install, so their absence stays
  informational. The line is *declared* vs *circumstantial*.
- `accept[]` is surfaced in `lock check` output, in `lock show`, and in every
  report under "Acceptance criteria (human judges)" — and it joins the
  Unchecked/judgment count in the summary. It does not silently block
  `verified` in v1 (matches the custom-clause convention) but it can never be
  invisible again.

## Design sketch

- Verdict enum gains `incomplete`. Rule order: `violated > 0 → failed`; else
  `declared-and-unrunnable > 0 → incomplete`; else `verified`.
- "Declared" sources: `verifyCommand` (always), `tests-pass` (already
  fail-closed on an empty glob), `output-unchanged`, `api-unchanged`,
  `no-new-dependency` — the last three when their baseline-dependent capture
  failed with a recorded error (`BaselineOutput.error` already exists and is a
  natural `incomplete`).
- Summary wording: `incomplete` → "Not verified: <the check that didn't run>."
  The word "verified" never appears for that verdict.
- `accept` gets a fixed render slot (report body + markdown + JSON), and
  `lock check` lists the criteria with the "human judges" marker.

## Tests / acceptance

- Update `test/verify.test.ts:328-360` (currently pins timeout → unchecked →
  run passes) to the new verdict; add report tests for `incomplete`.
- Eval case: verifyCommand timeout → `status: incomplete`, exit non-zero.
- Eval case: accept strings present in `--format=json`.
- Done = reproduction 1 exits non-zero with `incomplete`; reproduction 2 lists
  both criteria.

## Open decisions

- Exit code for `incomplete`: keep 1, or a new code 3 so CI can distinguish
  "broke something" from "couldn't check" (recommend 3 if CI will consume it).
- Whether acceptance criteria later become gating (ack-required) or stay
  advisory with visibility.
