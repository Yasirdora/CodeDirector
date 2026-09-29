## Final recheck — R1–R4

  Read `resolution.md` (including the Final delta), the refreshed `src/mcp/jobs.ts`, `test/mcp-responsive.test.ts` (top, 115-184), and `docs/ROADMAP.md:78-102`. Nothing run, nothing edited, nothing outside this snapshot.

  **No remaining actionable findings.** Each fix checks out for a *real* defect:

  - **R1 (malformed-Git / absent-Git fallback) — sound.** `gitAncestor` (`jobs.ts:15-25`) now runs before any diagnostic classification (`jobs.ts:39-44`). Filesystem evidence therefore decides the ambiguous cases: a `.git` entry at the root or any ancestor makes the path Git territory, so every Git error there rethrows regardless of wording (`jobs.ts:43` requires `!ancestor`), and the stderr phrase is consulted only when no `.git` exists anywhere up the walk — where the message is unambiguous anyway. I traced the cases: genuine non-repo with Git → `physical`; malformed gitfile with Git → refuse; timeout/non-zero/other → refuse; executable missing (`ENOENT`, `jobs.ts:40`) → ancestor identity, else `physical`. No under-blocking is introduced: the no-Git path returns the nearest ancestor containing `.git`, which is the same identity the Git path produces for paths in the same worktree (both derive from the already-`realpath`'d input), so concurrent calls on one worktree still collide. Consistency between the two branches is what matters and it holds.
  - **R2 — closed; no TS finding raised.** Compilation is now evidenced (`tsc --noEmit` and `npm run build` green), so I make no definite-assignment claim about `server.ts:592`.
  - **R3 — mirrored correctly.** `ROADMAP.md:93-95` now states the indefinite guard/clean-exit wait, that probe timeouts still apply, and the parent-thread indexing limit; consistent with `README.md:133-137`.
  - **R4 — global env mutation gone.** The no-Git assertions run in a child via `spawnSync` with an explicit `env` (`test/mcp-responsive.test.ts:154-157`), so no sibling test can inherit a stripped `PATH`; `spawnSync` is imported (`:6`) and the child requires the built `../src/mcp/jobs.js`, which the `npm test` build produces. The malformed-`.git` assertion at `:160` now runs with a normal `PATH`, so it tests the refusal the R1 ordering actually implements.

  **Explicitly accepted limits (not defects)**

  - One boundary of R1, inherent to the design: when no Git executable exists, `.git` existence is the only evidence available, so a *broken* `.git` yields a shared ancestor identity instead of a refusal. That can only over-block paths under one directory, never let two calls in a worktree run concurrently. The Git-present path refuses, as required.
  - F1: a locked command that never exits retains its guard and delays clean exit indefinitely (no watchdog by decision, conflicting with approved cancellation semantics); documented at `README.md:133-135` and `ROADMAP.md:93-94`.
  - F6: other tools stay on the parent thread and large indexing in another worktree can delay liveness (`README.md:136-137`, `ROADMAP.md:94-95`).
  - Progress only for `run_locked`/`report`, token-scoped, no percentage, no absolute-deadline extension; read-only tools on a busy worktree are refused by design; no cross-process/CLI coordination; no recovery from abrupt process death.

  **Gate status:** unchanged from your note — still running externally. I make no claim that `npm test && npm run eval` is green.

