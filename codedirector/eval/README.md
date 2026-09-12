# Eval harness — a regression gate, not science

`npm run eval` executes every case in `cases/*.yaml` against the **real CLI**
(`cdir run` then `cdir report --format=json`) in a fresh temp git repo, scores
the result against the case's expectations, and exits non-zero if any case
regresses. That gate is the entire point: a change to the verifier, the
report builder, or the CLI that breaks a documented behavior fails the build.

## Case format

```yaml
name: tests-pass-fail
files:                      # written into a temp git repo, then committed
  src/math.js: |
    export function add(a, b) { return a + b; }
lock:                       # Vibe Check fragment; the harness fills in
  utterance: make math faster   # id/status/schemaVersion/budget.symbols/etc.
  keep:
    - kind: tests-pass
      glob: test/*.test.js
  budget:
    files: ["src/math.js"]
command: node -e '...'      # the change, run via `cdir run IL-0001 -- <command>`
expect:
  exitCode: 1               # process exit code of `cdir run`
  status: failed            # lock status afterwards (verified/failed)
  violationsContaining:     # substrings that must appear in report violations
    - "KEEP tests-pass"
  items:                    # {match, class, verdict}: some report item whose
    - { match: tests-pass, class: measured, verdict: violated }   # subject or
                            # clauseKind contains `match` must carry exactly
                            # this evidence class + verdict
  uncheckedMin: 0           # minimum size of the Unchecked bucket
```

Cases run in filename order (prefix with `NN-` to control it). A failing case
keeps its temp repo (the path is printed) for debugging; passing cases are
cleaned up.

## What this harness does NOT do

- **No LLM judge.** Nothing here asks a model whether output "looks good".
  Expectations are exact: exit codes, violation substrings, evidence classes.
- **No statistical rigor.** One run per case, no sampling, no confidence
  intervals. Deterministic fixtures make that acceptable for a regression
  gate; it would not be acceptable for a research claim.
- **No coverage of judgment quality.** It checks that the Unchecked bucket is
  populated when it should be — not whether a human would agree with a Lock.
- **Not blind.** Cases were written alongside the implementation. They guard
  against regressions of specified behavior; they do not discover new bugs.

Modeled on the blueprint's eval principle (paired, rubric-scored, gated),
implemented from scratch and deliberately narrow.
