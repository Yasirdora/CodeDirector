# Spec 04 — Signature evidence must match its name (finding #4)

Status: approved 2026-09-27 · third in the approved order.
Amendment (2026-09-27): for unannotated arrow consts, hash **parameters +
return annotation + initializer kind** — not the full initializer text.

## Problem

`api-unchanged` hashes only the extraction of the declaration node
(`signatureOf`, `src/core/parser.ts`; compared at `src/verify/verify.ts:167`
via `signatureHash`, `src/lock/check.ts:81-83`). The hash excludes the
`export` keyword (the parser *records* `exported`; it is simply not hashed),
inferred return types, and class members (the class signature stops at the
body). README currently labels the rung "proven" with only a parameters
caveat.

## Reproduction (all three verified; sha256 recomputation matched)

| Mutation | "signature" before = after | Reported |
|---|---|---|
| `export function f(n: number): number` → drop `export` | `function f(n: number): number` | held |
| `export const g = () => 1` → `() => "1"` | `g = ()` | held |
| delete `protected evictOldest()` from `class Cache` | `class Cache` | held |

Case 3 detail: the removed method is separately indexed
(`src/cache.ts#Cache.evictOldest : "protected evictOldest(): void"`), but a
clause naming the class is blind to it. Case 1 detail: the index records
`exported: true → false` while the hash stays identical.

## Required behavior

The hash covers a defined **syntactic declaration surface**:

- export/visibility status (hash it — the fact already exists on `SymbolInfo`);
- type parameters, parameter list, return-type annotation when present;
- for unannotated arrow consts: parameters + return annotation + **initializer
  kind** (e.g. literal-number vs literal-string vs call vs arrow-block) — so
  `() => 1` → `() => "1"` registers, while `() => 1` → `() => 2` stays held by
  design (the parser cannot infer types, and this spec does not pretend it
  can);
- for classes/interfaces/enums: the member surface (name + kind + signature +
  visibility), one level.

Report/README wording matches the surface ("declaration unchanged — export
status, parameters, annotations, members"). Formatting-only changes must not
trip it (whitespace canonicalization), and `PARSER_VERSION` bumps so old
indexes re-parse.

## Design sketch

- Extend `signatureOf` (and the Swift extractor) to build a canonical
  descriptor string, then hash it. Pure function of the AST — no inference.
- Members: join `memberName:memberKind:signature[:visibility]` in source
  order; nested types are already separate symbols (decide whether to include
  them in the owner hash).
- Consider a `signatureSurface: "declaration-v2"` tag in index/baseline so a
  cross-version comparison can warn instead of silently "holding".

## Tests / acceptance

- The three reproduction cases become parser/verify unit tests; keep
  `test/parser.test.ts:223` (added parameter) and `:252` (interface/type/enum
  members).
- Negative control: reformatting only (prettier-style whitespace) stays held.
- Eval case: arrow-const inferred-type change → violated.
- Done = all three reproduction cases report `violated` (case 3 at minimum,
  where the member surface is the whole point).

## Open decisions

- None blocking: the initializer-kind rule above is the approved resolution.
  Include-or-not nested types in the owner hash remains a small call at
  implementation time.
