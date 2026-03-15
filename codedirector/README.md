# Code Director (`cdir`)

**The contract/verification layer around coding agents.**

Code Director is built on one principle: **the human states what must be
true; the system finds out whether it is.** It does not trust an agent's
prose. It builds a structural model of the repository, computes what a
change could affect, enforces the scope the human approved, and reports
every claim with an evidence class.

This repository contains **Stage 1**: the CLI scaffold, the incremental
structural index, the ranked repo map, and blast-radius analysis. Later
stages (Intent Lock, scope enforcement, checkpoint/undo, Change Report,
eval harness) build on the APIs exported here.

## Evidence classes

Every claim the system makes is one of:

| Class | Meaning |
|---|---|
| **Measured** | Directly observed with instrumentation (traces, runs, diffs of artifacts) |
| **Proven** | Structurally guaranteed (signature hash match, lockfile diff empty, typecheck) |
| **Asserted** | Claimed by an agent or inferred, not differentially observed |
| **Unchecked** | Nobody checked. Naming this bucket honestly is a feature. |

Conservatism is policy: anything not differentially observed is Asserted at
best. A claim without an artifact reference is automatically Asserted.

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
  a git repo)

`--json` emits the same report as deterministic JSON (sorted keys).

Exit codes: `0` success · `1` failure (e.g. symbol not found) · `2` usage error.

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

**Schema law for later stages:** derived structures (edges, rankings,
reports) are computed from `RepoIndex` and never persisted, so a partial
re-index can never leave stale derived state. Keep it that way.

## Development

```sh
npm run build     # tsc → dist/
npm test          # build + node --test dist/test/
node dist/src/cli.js why ImagePipeline --root examples/demo-repo
```

`examples/demo-repo/` is a tiny TypeScript project (slider → pipeline →
export, an image-preview toy) used by the tests and by later stages as a
stable fixture.

## License

MIT. See [LICENSE](LICENSE).
