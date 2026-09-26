# ADR 0001 — Domains state facts; the core decides what they mean

**Status:** accepted · **Date:** 2026-09-26

## Context

Code Director's valuable machinery is ecosystem-neutral: scope control,
locks and sealing, the index and graph, blast radius, ranking, baselines,
isolated execution, differential verification, evidence classes and
reports. Before this decision, ecosystem knowledge was mixed into it:

- The typecheck rung was `tsc --noEmit`, gated on `tsconfig.json`.
- `tests-pass` could only mean `node --test`.
- Test files were recognised by `.test.ts` / `__tests__` alone.
- Imports resolved only as relative JavaScript paths.
- `package.json` fingerprinting lived in the run layer.
- Apple build directories, lockfiles and the `apple` profile sat in the
  walker, the lock types and the profile module.

Deeper Apple support (Swift compiler diagnostics, the Xcode project model,
SourceKit) would multiply those leaks. A separate "AppleDirector" would
duplicate the engine instead. Neither is acceptable.

## Decision

Ecosystem knowledge lives in **domains** (`src/domains/<id>/`). The core
consults them through a registry (`src/domain/registry.ts`) and the
contract in `src/domain/types.ts`. It never names one.

A domain registers only the capabilities it has. Each capability is
consulted at its own lifecycle stage:

| Capability | Stage | What the domain contributes |
|---|---|---|
| `projectFacts` | drafting | what kind of project this is (e.g. a SwiftPM package) |
| `graphFacts` | indexing | how its imports resolve, with provenance |
| `testMapping` | indexing, drafting, reporting | which files are tests; how to glob them |
| `dependencyFacts` | baseline, verification | manifests, and what in them counts as a dependency |
| `checkProviders` | baseline, verification, lock check | diagnostics checks, the tests-pass runner, toolchain reach — as descriptions |
| `changeClassifiers` | reporting (no consumer yet) | what kind of change a diff is, in the core's risk vocabulary |
| `profileRules` | drafting | `--profile` presets |
| `generatedPathRules` | indexing, drafting | never-source directories; paths a generator owns |

The core keeps everything else. It owns blast radius, ranking, evidence
classification, locks and sealing, scope enforcement, run isolation,
subprocess lifecycle, timeouts and cancellation, before/after comparison,
verification scheduling, artifacts and reports.

## Rules

1. **Domains state facts; the core decides what those facts mean.** A
   domain says "this file is a test" or "this manifest carries
   dependencies". Whether that holds a lock, fails a run or reaches a
   report is the core's decision.
2. **Domains describe checks; the core executes them.** A check is data:
   the invocation, how to read its output, when it doesn't apply. The core
   runs it under `runIsolated`, so whatever it writes is put back. The core
   also owns the timeout, the baseline comparison and the evidence class.
   A domain module must not import process execution; a test enforces this.
   There is no domain `runVerification()` and never will be.
3. **Graph algorithms remain shared.** Blast radius, transitive callers,
   PageRank and test lookup are one implementation. A stronger domain makes
   the same algorithm's answer better by contributing facts. There is no
   domain `analyzeImpact()`.
4. **Facts carry provenance and freshness.** Every graph edge records:
   - its source (`tree-sitter`, `inferred`, `typescript`, `sourcekit`,
     `indexstore`, `xcode-project`, `swiftpm`, …),
   - the domain that contributed it,
   - its evidence (`proven` / `measured` / `asserted`),
   - its freshness (`current` / `stale`).

   Numeric confidence scores are not used. An uncalibrated number would
   read as a measurement it isn't.
5. **Compiler and index facts become invalid when their source revision is
   stale.** A fact that outlives the build that produced it records the
   content hash it was derived from. When the file's hash moves on, the
   fact is `stale` and carries no evidence (`effectiveEvidence` → `null`).
   Syntax-derived facts are rebuilt from the current file on every index,
   so they are current by construction.
6. **Stronger evidence ranks above heuristic evidence but does not erase
   it.** When a second source establishes an existing edge, its provenance
   is appended and ranked, never substituted. A compiler that finds no
   reference does not delete a heuristic one: it outranks it.
7. **Verification is differential where possible.** Diagnostics are
   captured before the run and after it. Only what the run added is its
   violation. A baseline without that record falls back to the strict
   reading and says so.
8. **Heuristics may escalate verification but may not silently remove
   sealed checks.** The human approved the lock's checks by sealing it. A
   classifier may add a check or a finding. It may never skip, weaken or
   replace one the lock promised.
9. **Expensive escalation stays inside an approved verification budget or
   policy.** A domain that proposes an extra build or test run does not
   get it for free. What escalation may spend is approved like any other
   part of the contract.
10. **"Not checked" is a legitimate evidence state.** A check that doesn't
    apply, can't run or times out is reported as Unchecked with its reason.
    It is never silently omitted and never rounded up to held.
11. **Domain specialization must not contaminate the generic core.** No
    core file imports a domain module. Only the registry composes the
    built-in domains, and `src/index.ts` re-exports two names for
    compatibility. Tests enforce this and keep a named list of the
    ecosystem names still present in core code.

## Consequences

- **Adding an ecosystem changes no core file.** `test/domains.test.ts`
  registers a synthetic domain that exercises every capability through the
  unchanged core.
- **Registration order is observable.** Contributions are unioned in
  registration order (Node, then Apple). This order shows up in a draft's
  deny list and in coverage messages.
- **All registered domains contribute unconditionally.** Activating a
  domain by `projectFacts` would change what an existing repository is
  judged by, so it is a separate, deliberate decision.
- **`tests-pass` has at most one runner.** The clause names no runner, so
  two would make it ambiguous. The registry refuses a second one until the
  clause can name its runner.
- **Baselines record diagnostics per check** (`diagnostics[checkId]`).
  Baselines captured before this change stored tsc's errors in
  `typecheckErrors`; a check's `legacyBaselineField` keeps them readable.

## Known remainders

These are listed on purpose. Each is a later change, not an oversight.

- **Tree-sitter extractors are still core.** The TypeScript/JavaScript/Swift
  extractors (`core/parser.ts`, `core/swift.ts`) and `INDEXABLE_EXTENSIONS`
  are the shared syntactic layer. Moving extraction behind `graphFacts` is
  possible once a second source of symbols exists.
- **The language table is still core.** `languageOf` in `lock/draft.ts`
  names files by extension for twenty languages, most of which have no
  domain. Toolchains for languages no domain claims (pytest, go, cargo,
  gradle/maven) stay in `lock/check.ts` until a domain claims them.
- **`dirLineCount` skips `node_modules`.** It counts lines in untracked
  directories (`run/classify.ts`). Using the registry here would also skip
  Apple build directories and change line counts, so it waits for a change
  that is allowed to change behaviour.
- **Some help and hint text names Node conventions.** Examples such as
  `tests-pass:test/**/*.test.ts` and "add a glob like `src/**/*.test.*`" are
  user-facing strings in lock files. They stay until drafting takes
  examples from the owning domain.

## Sequence

| PR | Scope |
|---|---|
| 1 | Domain seams, provenance model, this ADR. No behaviour change. |
| 2 | Generic check-descriptor and check-provider infrastructure (scheduling, cost, adaptive and differential policy), then Swift compiler diagnostics. A SwiftPM package gets `swift build`; an Xcode project or workspace gets a resolved `xcodebuild` target/scheme check. Schemes are never guessed. Nothing builds automatically after every change. |
| 3 | Apple project model: SwiftPM and Xcode targets, modules and membership. |
| 4 | Swift test mapping and stronger blast radius, on top of the project model. |
| 5 | xcresult parsing. |
| 6 | SourceKit-LSP as a fact source, with freshness keyed to file hashes. |
