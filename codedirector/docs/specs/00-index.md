# Fix specs — approved 2026-09-27

Six fix specs for the issues found in the 0.4.5 review. Written against HEAD
`bb4b0cd` (2026-09-26). Each spec has a reproduction, required behavior, a
design sketch, and a test/acceptance list. No implementation is included.

## Implementation order (approved)

1. **06** — MCP parity for KEEP clauses and `verifyCommand`
2. **05 + 01 + 03 — one arc** — record identity, task baseline, and fresh scope
   deltas share the same data model (`classify.ts`, `run.ts`, `baseline.ts`,
   `verify.ts`, `report.ts` all move together)
3. **04** — signature surface
4. **02** — verdict semantics for required checks; `accept`

## Amendments (2026-09-27, approved)

- **Spec 05**: no repo-wide state lock. Multiple concurrent agent sessions on
  one repository are the supported reality; uniqueness and atomicity must be
  per record (exclusive id allocation + atomic writes).
- **Spec 04**: for unannotated arrow consts, hash parameters + return
  annotation + initializer *kind* — not the full initializer text.

## Provenance

Reproductions were verified end-to-end on snapshot `08a7f84` (2026-09-19);
the mechanisms were confirmed present and unchanged at `bb4b0cd` by source
inspection. File references are to `bb4b0cd` line numbers and drift as code
moves. One eval case or unit test per spec is expected to land with its fix,
per the ROADMAP convention (status / reproduction / fix / test).
