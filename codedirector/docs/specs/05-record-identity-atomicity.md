# Spec 05 — Record identity and atomicity (finding #7)

Status: approved 2026-09-27 · first half of the second arc (with 01 + 03).
Amendment (2026-09-27): **no repo-wide state lock.** Multiple concurrent agent
sessions on one repository are the supported reality; uniqueness and atomicity
must be per record (exclusive id allocation + atomic writes).

## Problem

Baseline and run-record filenames are truncated to the second
(`src/run/baseline.ts:117-120`, written at `:254-259`; `src/run/run.ts:313-315`),
all writes are plain `writeFileSync` (no temp+rename), `latestBaselinePath`
picks by filename sort (`baseline.ts:275-282`), and lock ids are "max existing
+ 1" without exclusivity (`src/lock/store.ts:49-53`). Two captures in one
second overwrite each other. Checkpoints are ms-stamped, but the records that
name them are not.

## Reproductions

1. Deterministic (API): call `saveBaseline` twice with baselines whose
   `capturedAt` share a second — the second file overwrites the first; one
   path remains where two are expected.
2. End-to-end: two no-op `cdir run`s landing in the same wall-clock second →
   one run record where two are expected; `latestBaselinePath` then selects by
   name, not by "attempt 2".
3. Concurrent-session hazard: two sessions running in one repo interleave
   whole-file writes to `seals.json` (observed during runs); last writer wins,
   earlier entries can vanish.

## Required behavior

- **Unique by construction**: every persisted record gets a collision-proof id
  (ULID or `<UTC-ms>-<counter>` with exclusive-create allocation),
  independent of wall-clock resolution. Applies to baselines, run records,
  and seal state.
- **Atomic writes**: temp file + `rename` for every JSON/YAML state write.
  Readers see the old or the new full file, never a partial one.
- **Concurrency without a state lock**: per-record files are the mechanism —
  e.g. seal entries as `.codedirector/seals/<id>.json` instead of a shared
  `seals.json`, or an atomic read-modify-write with retry for stores that must
  stay single-file. Two sessions on one repo must complete without
  serializing each other and without losing either session's records.
- **Lock-id allocation is exclusive** (create-or-fail loop, not read-max-then-write).
- `latestBaselinePath`-style selection becomes a legacy fallback only: with
  Specs 01/03, records reference their baseline explicitly and nothing depends
  on name ordering.

## Design sketch

- New `src/core/ids.ts` (`newRecordId()`, `writeFileAtomic()`), used by
  run/baseline/seal/checkpoint stores.
- Migration: legacy second-stamped files stay readable (fallback path); new
  files are only ever written with new ids. No renames required.
- Seal store shape change is the one visible data migration: read both
  `seals.json` and `seals/<id>.json`; write the per-record form.

## Tests / acceptance

- Deterministic collision test (same-second writes → two files, both parse).
- Reader-during-write test (atomicity): a parse loop never sees partial JSON.
- Parallel test: N spawned processes allocate N distinct lock ids and N
  distinct records; two concurrent seal updates both survive.
- Done = reproduction 1 creates two distinct files; `npm test` covers all
  three cases.

## Open decisions

- Stale-lock handling is out of scope by amendment: no locks in this design.
- Whether to adopt ULIDs (tiny generator or dependency) vs ms+counter.
