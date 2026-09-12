# Code Director (`cdir`)

**Say what you want done — and what must stay untouched. cdir runs the work, watches what moves, and tells you what it checked — and what it couldn't.**

## What is this?

You write down the job: the goal, the files in scope, and the promises
that must hold — "these APIs don't change," "these tests still pass,"
"no new dependencies." That record is a Lock: a plain YAML file in your
repo, one you can read and edit.

Then the work happens inside it — a script, a coding agent, your own
edits. `cdir` watches every file the work touches, blocks nothing on its
own, and afterwards shows you exactly what happened: what changed, what
stayed inside the agreement, which promises it could verify, and which
nobody could verify. The answer comes in plain English first; the
evidence sits underneath for when you want it.

```
cdir lock new "make the preview feel instant, don't touch export"
cdir run IL-0001 -- <the command that does the work>
cdir report IL-0001
```

It is for anyone who lets an agent — or a teammate, or themselves on a
tired Tuesday — edit a repository, and wants the scope kept and the
claims shown, not narrated.

## The principle

**You state what must be true. cdir finds out whether it is.** It does
not take an agent's word for it: it maps the repository, computes what a
change could affect, holds the work to the scope you approved, and marks
every claim with how it was checked.

## Evidence classes

Every claim the system makes is one of:

| Class | Meaning | Produced by |
|---|---|---|
| **Measured** | Observed differentially, pre and post, same harness | test runs, output stdout hashes, `verifyCommand` |
| **Proven** | Structurally guaranteed, no execution needed | signature hash match, manifest/lockfile diff, clean typecheck |
| **Asserted** | Claimed without a differential check — always labeled | findings, any claim that lost its artifact reference |
| **Unchecked** | No check exists or none could run — named, with the reason | custom clauses, missing baselines, unavailable compilers |

Conservatism is policy: anything not differentially observed is Asserted at
best. **A claim without an artifact reference is automatically Asserted —
enforced in code** (`enforceArtifactRule`), not by discipline. The Unchecked
bucket is always rendered, even when empty; a report that hides it is lying.

Two honesty limits worth knowing:

- **Signature evidence covers the full callable surface** — including
  initializer-declared functions (`export const compose = <E>(a, b) => …`),
  whose signatures include type parameters, the parameter list, and the
  return-type annotation. (A field-reported defect where adding a parameter
  to a const-arrow left the hash unchanged is fixed and covered by parser
  tests + two eval cases; `PARSER_VERSION` was bumped, so old indexes
  re-parse.) Plain value consts still exclude the value, by design.
- **Baselines are tamper-evident, not tamper-proof.** The baseline file's
  sha256 is recorded in the run record at capture; verification re-hashes
  and, on mismatch, marks every baseline-dependent check Unchecked —
  "baseline modified during execution — run invalid" — and fails the run.
  But `.codedirector/baselines/` is still inside the tree the executed
  command can write: a command that rewrites the baseline *and* the record
  could evade this. True oracle separation (baseline outside the writable
  tree / read-only verifier process) remains a later phase.

## Install

```sh
npm install
npm run build
npm link        # optional: puts `cdir` on your PATH
```

Requires Node ≥ 20. No native builds: parsing is pure WASM.

## Command reference

### `cdir index [--root DIR]`

Build or refresh the structural index at `.codedirector/index.json`.
Incremental: each file's sha256 is stored; only new/changed files are
reparsed. Honored skips: `.git`, `node_modules`, `dist`, `.codedirector`,
plus root `.gitignore` / `.ignore` patterns (nested `.gitignore` files are
not yet honored).

### `cdir map "<query>" [--top N] [--max-tokens N]`

Prints a ranked repo map: symbols most relevant to the query, ordered by
personalized PageRank over the symbol graph (restart vector biased to the
anchor symbols that matched the query), packed to a token budget
(1 token ≈ 4 chars). Deterministic: same index + same query ⇒ same map.

### `cdir why <symbol> [--json]`

Blast radius for a symbol — genuinely useful with no AI involved:

- where it is defined (file:lines, signature)
- direct callers (reverse call edges)
- transitive callers to depth 3, with per-depth counts
- which test files reference it (`*.test.*` / `*.spec.*` / `__tests__`)
- historical co-change coupling (top files committed together with the
  defining file, from `git log --name-only`; degrades gracefully outside
  a git repo). Skipped with a printed reason on shallow clones
  (`git rev-parse --is-shallow-repository`) and on histories under 30
  commits — on a `--depth 1` clone the single commit touches every file, so
  the coupling report would be pure noise.

`--json` emits the same report as deterministic JSON (sorted keys).

Exit codes: `0` success · `1` failure (e.g. symbol not found) · `2` usage error.

### `cdir lock new "<utterance>" [--goal TEXT] [--keep SPEC] [--deny GLOB] [--budget-files F]`

Drafts an **Vibe Check** — a compiled, enforceable contract, human-readable
YAML versioned at `.codedirector/locks/IL-<NNNN>-<slug>.yaml`. The command is
interactive-free: it resolves anchor symbols from your words, computes blast
radius, and PROPOSES `budget.files` (defining files of the top-ranked
symbols) plus a suggested `deny` list (dependency manifests, unrelated test
files). Anchor matching is tiered — exact name, then name-token, then lexical
fuzz — and when only lexical fuzz matches, the draft **abstains**: empty
budget plus a guidance assumption, rather than a confidently wrong one. Deny
suggestions are compressed to directory globs and capped at 8 entries; any
omission is counted in the lock's assumptions, never silent. The draft is
written with `status: draft` — edit it, then
`cdir lock check IL-XXXX` and `cdir lock activate IL-XXXX`.

The Lock schema (v1): `utterance` (your exact words, immutable), `goal`,
`interpretation` (the system's operationalization — editable), `keep[]`,
`deny[]`, `change`, `verifyCommand` (optional user test harness, e.g.
`npm test` — run as measured evidence), `budget {files, symbols, maxFiles,
maxLines}`, `accept[]`, `assumptions[]`. KEEP clause kinds:

| Kind | Payload | Checked how |
|---|---|---|
| `api-unchanged` | symbol ids | ✓ signature hash, diffed against the pre-change baseline (proven) |
| `no-new-dependency` | — | ✓ dependency maps in package.json + lockfile hashes vs baseline (proven) |
| `output-unchanged` | entry command + fixtures | ✓ stdout **and stderr** sha256, captured at baseline, re-run at verify (measured) |
| `tests-pass` | test glob | ✓ `node --test <glob>` (measured); empty glob is a violation |
| `custom` | free text | ? not machine-checkable — always Unchecked, human judges |

A Lock **rejects** clauses it cannot even in principle check, unless
`kind: custom` — and custom clauses are always flagged as human-judged.

`--keep` SPECs: `api-unchanged:<file>#<symbol>` (comma-separated ids),
`tests-pass:<glob>`, `output-unchanged:<command>`, `no-new-dependency`,
`custom:<text>`.

### `cdir lock ls` · `cdir lock show <id>` · `cdir lock check <id>` · `cdir lock activate <id>`

`show` renders the Lock with per-clause checkability markers (✓ machine-checkable / ? human judges).
`check` validates against the current index — budget files exist, symbols
resolve, deny globs valid, `maxFiles >= files.length` — and exits non-zero
on invalid. `activate` moves draft → active only when check passes.

### `cdir checkpoint` · `cdir undo [--force] [--keep-untracked]`

Git-native safety net (blueprint §19): `checkpoint` records a lightweight
tag `cdir/ckpt-<timestamp>` at HEAD plus a byte snapshot of dirty /
skip-worktree files under `.codedirector/ckpt-blobs/`. `undo` resets to the
tagged ref and restores that snapshot — including a dirty tree as of
checkpoint time (`--force`) and skip-worktree files that `git reset --hard`
would otherwise leave. Honest limit: git cannot undo external side effects.

**⚠ Behavior change from v0.1.0:** untracked files created *after* the
checkpoint are **deleted** by undo (v0.1.0 left them in place). The files
are enumerated and printed to stderr *before* deletion, and the deleted list
is shown again in the undo output. Pass `--keep-untracked` to preserve them.

### `cdir run <lock-id> [--allow-expand] [--no-report] -- <command...>`

Verified execution inside an active Lock:

1. auto-checkpoint (git tag) before anything;
2. refresh the index and capture the KEEP baseline — signature hashes of
   every `api-unchanged` symbol, dependency fingerprints, **stdout+stderr
   hashes of every `output-unchanged` command** (probes are isolated so they
   cannot mutate the tree), plus HEAD / dirty hashes / skip-worktree state —
   to `.codedirector/baselines/` (gitignored);
3. run the command (spawned, stdio inherited);
4. classify every file the command actually touched against the Lock — delta
   vs the pre-run baseline, not vs current HEAD, so `git commit`, `git mv`,
   and skip-worktree cannot hide a deny. Writes outside `--root` are
   out-of-budget. Pre-existing dirt is not billed to the command. Denied or
   out-of-budget changes are violations; nothing is auto-reverted (`cdir undo`
   is offered).
   `--allow-expand` is the logged override for scope growth only — a broken
   KEEP clause still fails;
5. **run the verification ladder** (see below) against the baseline;
6. write the run record (including the full verification result) to
   `.codedirector/runs/`, update the lock status (`verified` / `failed`), and
   emit the Change Report (`--no-report` suppresses the rendering, not the
   verification).

Exit code: `0` only if the command succeeded AND no violations. `cdir run`
without a lock id is refused — ad-hoc mode is a later phase; the whole point
is the contract.

### The verification ladder

After execution, every KEEP clause and every lock-level claim is verified as
far as possible, in ladder order (cheapest/strongest first):

1. **Structural (proven)** — re-index; each `api-unchanged` symbol's
   signature hash compared pre/post (types/interfaces/enums include their
   members; function signatures are not truncated); `no-new-dependency`
   diffs dependency maps in `package.json` plus lockfile hashes. Both
   produce `proven` held or violated.
2. **Typecheck (proven when clean)** — if `tsconfig.json` exists and a
   compiler is available (`node_modules/typescript`, else
   `npx --no-install tsc`), run `tsc --noEmit` with a 120s timeout. Clean →
   proven; errors → measured violation; no compiler or no tsconfig →
   Unchecked with the reason named.
3. **Tests (measured)** — each `tests-pass` glob is expanded and run via
   `node --test` with a timeout; pass → measured, fail → measured violation
   with the failing test names, empty glob → **violated** (fail closed). A
   Lock-level `verifyCommand` (e.g. `npm test`) runs the same way. Probes
   are isolated (tree restored afterwards) and strip `NODE_TEST_CONTEXT`.
4. **Output (measured)** — each `output-unchanged` command is re-run in
   isolation and its stdout **and stderr** sha256 compared to the baseline
   capture. If the lock was edited after the baseline was captured, the
   clause is Unchecked — "no pre-change baseline" — never silently held.
5. **Custom (unchecked)** — always `unchecked — human judges`, listed by
   text. This honesty is the feature.

The verifier writes nothing to the repository (the index refresh touches only
`.codedirector/`). The probed commands themselves run with normal repo
permissions — a fully sandboxed verifier is a later phase.

### `cdir verify <lock-id>`

Re-runs the ladder without re-running the change command: latest baseline for
the lock, fresh index, all rungs. Without any baseline, structural and output
checks report Unchecked ("no pre-change baseline") while tests and typecheck
still run. Updates the lock status; exit 0 only when verified.

### `cdir report <lock-id> [--format=terminal|md|json]`

Renders the **Change Report** — the product's signature artifact. It opens
with a plain-language summary generated from the same data as the detail
("Done — verified. Only src/preview.ts changed, within the agreed scope. 2
promises held (checked). 1 thing needs your judgment…" — or, on failure,
"Blocked: src/export.ts was outside the agreed scope. Nothing was reverted —
run `cdir undo` to restore."). The summary never says "verified" when
violations exist; the detail follows underneath:

- lock id + the original utterance, verbatim and immutable;
- changed files with classification (in-budget / out-of-budget / denied) and
  the budget they were measured against;
- every KEEP clause and lock-level check with verdict, evidence class, and
  artifact reference (which baseline file, which command, which exit code) —
  violations first, then verified-held, then the Unchecked bucket (always
  visible, each item with its reason);
- findings: incidental observations (e.g. "src/x.ts changed in-budget but no
  test file references it — behavioral coverage unknown"), always Asserted
  and labeled;
- a footer with counts per evidence class.

`--format=md` is PR-postable markdown; `--format=json` is deterministic
(`stableStringify`). The report builder downgrades any held claim lacking an
artifact reference to Asserted — schema-enforced, per the blueprint. Report
verdicts update the lock status, so `cdir lock show` reflects them.

Sample (clean run):

```
CHANGE REPORT · IL-0001 · verdict: VERIFIED
Said   "make the preview feel instant"
Goal   input-to-paint under 50ms during drag
Run    node scripts/inline-debounce.js · record .codedirector/runs/IL-0001-….json

Changed files (1 changed · budget 1/2 files, 3/400 lines):
  ✓ src/preview.ts  in-budget

Violations: none

Checks (violations first):
  ✓ proven   api-unchanged · src/pipeline.ts#ImagePipeline.renderExport — signature unchanged
             artifact: .codedirector/baselines/IL-0001-….json#signatures[src/pipeline.ts#…]
  ✓ measured tests-pass · test/*.test.ts — 1 test file(s) pass under node --test
             artifact: node --test test/*.test.ts (1 file(s)) → exit 0

Unchecked (1) — named, not silently dropped:
  ? custom · feels right above 8K sources — not machine-checkable — human judges

Counts: proven 1 · measured 1 · asserted 0 · unchecked 1
```

## Design principles

1. **Human states what must be true; the system finds out whether it is.**
2. **Evidence, not assertion.** Every claim carries an evidence class and an
   artifact reference.
3. **Determinism.** Index, map, and report outputs are byte-stable for
   identical inputs (sorted keys, stable ordering). The Change Report stage
   depends on this.
4. **Useful before it is smart.** `cdir why` works in minute one, with no
   configuration and no model in the loop.
5. **Local-first.** The index lives in the repo at `.codedirector/`; nothing
   leaves the machine.

## Eval harness

`npm run eval` runs the cases in `eval/cases/*.yaml` against the real CLI in
temp git repos and scores them against explicit expectations (exit codes,
violation substrings, per-clause evidence class + verdict, minimum Unchecked
bucket size). It is a **regression gate**: any failed case exits non-zero.
It is deliberately not more than that — no LLM judge, no statistics, not
blind. See [eval/README.md](eval/README.md).

## What this is NOT yet

Per the blueprint's phasing, honestly:

- **No LLM agent loop.** `cdir run` wraps a command you (or your agent)
  provide; it does not plan, edit, or repair by itself.
- **No sandboxed verifier.** Probed commands run with repo permissions; our
  code writes nothing, but a compromised test script could. Baselines are
  tamper-EVIDENT (capture-time sha256 re-checked at verify; a mismatch
  invalidates the run), not tamper-proof — full sandboxing and moving the
  baseline outside the writable tree are later phases.
- **No characterization generation.** `output-unchanged` pins the output of
  commands you name; it does not auto-generate behavior-pinning tests over
  the KEEP surface (blueprint phase 1.5+, with a mutation-testing gate).
- **No performance measurement rung.** Latency/memory claims are not
  measurable yet — such clauses belong in `custom` (human judges) for now.
- **No symbol-level budget enforcement.** `budget.symbols` is advisory;
  enforcement is file-level.
- **Heuristic parsing.** Call edges are name-resolved, not type-resolved;
  compiler-grade precision (LSP) is a later phase.

### Where we deliberately stop

`cdir` is a contract checker, not a sandbox. Known evasion paths are
instrumented and reported, and every success claim carries its evidence
class — but we do not claim "the agent couldn't have cheated," only "if it
had, you would see it." Kernel-level isolation, a read-only verifier process,
and merge-only-in-budget worktrees are real options, and we have chosen not
to build them yet. The next layer gets picked by evidence, not by anxiety:
we consolidate what exists, let users hit the referee in daily work, and let
their complaints — not our imagination — decide what hardens next. The name
"lock" belongs to the YAML contract; it is not a security claim.

## Architecture

```
src/
  cli.ts            arg parsing, commands, exit codes
  index.ts          public API barrel — later stages import from here
  core/
    types.ts        RepoIndex / FileIndex / SymbolInfo / CallSite / CallEdge
    walk.ts         repo walker (.gitignore-aware, fixed skip set)
    parser.ts       web-tree-sitter WASM extraction (symbols, imports, calls)
    builder.ts      incremental index builder (sha256 content hash per file)
    store.ts        .codedirector/index.json persistence (deterministic JSON)
    graph.ts        symbol graph: call-edge resolution, callers, tests
    rank.ts         personalized PageRank over the symbol graph
    map.ts          token-budgeted ranked repo map
    why.ts          blast-radius report (composed from graph + git)
    git.ts          co-change mining via git log --name-only
  lock/
    types.ts        VibeCheck / KeepClause / LockBudget / schema v1
    yaml.ts         stable YAML round-trip + strict validation
    glob.ts         glob matching/validation for deny, budget, test globs
    store.ts        .codedirector/locks/IL-NNNN-slug.yaml persistence
    draft.ts        lock new — anchors + blast radius propose budget/deny
    check.ts        lock check — validation + signature-hash primitive
    show.ts         lock show — blueprint-style rendering, ✓ / ~ / ? markers
  checkpoint/
    index.ts        git tag checkpoints, one-command undo, dirty-tree guard
  run/
    baseline.ts     pre-run KEEP surface capture (outside the source tree)
    classify.ts     changed-file classification: denied/out-of-budget/in-budget
    run.ts          cdir run — checkpoint → baseline → execute → enforce → verify → record
    probe.ts        read-only command probes (bounded timeout, sanitized env)
  verify/
    types.ts        EvidenceClass / VerificationItem / artifact-reference rule
    verify.ts       the ladder: structural → typecheck → tests → output → custom
  report/
    report.ts       Change Report builder + findings + lock status transitions
    format.ts       terminal / markdown / deterministic-JSON renderers
eval/
  cases/*.yaml      regression-gate cases (repo setup, lock, command, expect)
  run.ts            npm run eval — executes cases against the real CLI, gates
```

### Parsing choice

Parsing uses **web-tree-sitter** (pure WASM, no native compilation) with the
official `tree-sitter-typescript` / `tree-sitter-javascript` npm packages,
which ship prebuilt `.wasm` grammars. This was the first-choice option and
installed cleanly; no fallback was needed. Extraction is syntax-level and
heuristic — call edges are resolved by name (same-file → import → unique
name), not by types. Method calls (`obj.m()`) are best-effort. This is
documented behavior, not a bug: compiler-grade precision is a later phase
(LSP integration).

### Internal API surface (for Stage 2+)

Import from the package root (`codedirector` / `dist/src/index.js`):

- `buildIndex(rootDir, opts?) → { index: RepoIndex, stats: BuildStats }` —
  incremental build; `stats.filesParsed` is the reparse counter.
- `loadIndex(rootDir) → RepoIndex | null`, `saveIndex(rootDir, index)`,
  `stableStringify(value)` — persistence + deterministic JSON.
- `buildGraph(index) → SymbolGraph` — resolved edges,
  `directCallers / directCallees / transitiveCallers(graph, id, depth)`,
  `testFilesFor(index, symbol)`, `resolveModule(fromFile, specifier, index)`.
- `rankSymbols(graph, anchorIds) → RankedSymbol[]` — personalized PageRank
  (damping 0.85, 50 iterations, call weight 1.0, same-file weight 0.15).
- `buildRepoMap(index, query, { top, maxTokens })`, `formatRepoMap(...)`.
- `blastRadius(rootDir, index, query) → BlastRadiusReport`,
  `formatBlastRadius(...)`, `findSymbols(graph, query)`.
- `coChange(rootDir, relFile)`, `isGitRepo(rootDir)`.
- Types: `RepoIndex`, `FileIndex`, `SymbolInfo`, `CallSite`, `CallEdge`,
  `BlastRadiusReport`, `INDEX_SCHEMA_VERSION`, `PARSER_VERSION`.

**Stage 2 additions (for Stage 3 — verification + Change Report):**

- Vibe Check: `loadLock`, `listLocks`, `saveLock`, `nextLockId`,
  `draftLock`, `parseKeepClause`, `checkLock`, `signatureHash`,
  `lockToYaml` / `lockFromYaml` (stable YAML round-trip), `formatLock`;
  types `VibeCheck`, `KeepClause`, `KeepClauseKind`, `LockBudget`,
  `LockAssumption`, `LockStatus`, `ClauseCheckability`; glob helpers
  `matchPath`, `validateGlob`, `globToRegExp`.
- Checkpoint/undo: `createCheckpoint`, `latestCheckpoint`, `undo`,
  `gitStatusPorcelain`, `workTreeStatusPorcelain`, `dirtyPaths`,
  `gitPrefix`, `toRootRelative`; types `Checkpoint`, `UndoRecord`,
  `UndoResult`.
- Run: `captureBaseline(rootDir, lock, index)` + `saveBaseline`,
  `classifyChanges(rootDir, lock)`, `changedFiles`, `changedLineCount`,
  `runWithLock(rootDir, lockId, command, opts)`, `formatRunReport`;
  types `Baseline`, `RunRecord`, `RunOutcome`, `ClassifiedChange`,
  `KeepResult`, `BudgetStats`.

**Stage 3 additions (verification + Change Report + eval):**

- Verify: `verifyLock(rootDir, lockId, opts)`,
  `verifyWithBaseline(rootDir, lock, baseline, baselineRel, index, opts)`,
  `enforceArtifactRule(items)` (a held claim without an artifactRef becomes
  Asserted), `runShellProbe` / `runArgvProbe` (read-only probes),
  `loadBaseline`, `latestBaselinePath`; types `EvidenceClass`, `Verdict`,
  `VerificationItem`, `VerificationReport`, `VerifyOptions`.
- Report: `buildReport(rootDir, lockId, opts)`, `finalizeLockStatus`,
  `latestRunRecord`, `formatReport` / `formatReportMarkdown` /
  `formatReportJson`; types `ChangeReport`, `Finding`, `BuildReportOptions`.
- Lock schema gained an optional `verifyCommand` field (user harness, run as
  measured evidence); `Baseline` gained optional `outputs` (stdout hashes of
  `output-unchanged` commands, captured pre-change).

**Schema law for later stages:** derived structures (edges, rankings,
reports) are computed from `RepoIndex` and never persisted, so a partial
re-index can never leave stale derived state. Keep it that way.

## Development

```sh
npm run build     # tsc → dist/
npm test          # build + node --test dist/test/
npm run eval      # build + regression gate over eval/cases/*.yaml
node dist/src/cli.js why ImagePipeline --root examples/demo-repo
```

`examples/demo-repo/` is a tiny TypeScript project (slider → pipeline →
export, an image-preview toy) used by the tests and by later stages as a
stable fixture.

## License

MIT. See [LICENSE](LICENSE).
