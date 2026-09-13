---
name: codedirector
description: Agree on scope before editing code, then prove what changed. Use for any request to modify, refactor, fix, or build in a repository — draft a Vibe Check (scope contract) with cdir, get the user's confirmation, work inside it, finish with a Change Report. Prevents scope creep, unrequested renames, and unverified "done" claims.
---

# Code Director

`cdir` (or the equivalent MCP tools) turns a vague request into an approved
scope, fences the work to it, and reports what was verified. Follow this for
every code change.

**Rule zero: never edit before the user approves the scope.** When in doubt,
keep the budget small.

## Workflow

1. **Map** (once per session): `cdir index` + `cdir map "<the user's words>"`.
   Blast-radius questions: `cdir why <symbol>`.
2. **Draft**: `cdir lock new "<exact words>" --goal "<what done means>"`. Show
   the user — plainly — the goal, budget, deny list, assumptions. Ask **at
   most one** question, only when the request is genuinely ambiguous (two
   materially different readings); otherwise record an assumption in the lock
   instead of asking. After an explicit yes:
   `cdir lock check IL-XXXX && cdir lock activate IL-XXXX`.
3. **Work**: `cdir run IL-XXXX -- <command>`; or when editing directly:
   `cdir checkpoint`, touch only budgeted files, then `cdir verify IL-XXXX`.
   Need a file outside the budget? Stop and ask — a scope change is the
   user's call, never yours.
4. **Report**: `cdir report IL-XXXX`. Plain summary first; name violations
   and the Unchecked bucket; never claim "verified" from your own narration.
   On failure, say so and offer `cdir undo`.

## Fast lane

Small, unambiguous changes (1–2 files, one clear reading): skip step 1,
draft a minimal lock, get the yes, proceed. The approval gate is never
skipped — only the ceremony shrinks.

## Never

- Edit, rename, delete, or restructure outside the approved budget
- "While I'm here" improvements the user did not ask for
- Silent scope expansion, however obviously right it seems
- Success claims without the report

## MCP mapping

`repo_map` → 1 · `lock_draft` / `lock_check` / `lock_activate` → 2 ·
`run_locked` → 3 · `report` / `undo` → 4 · `blast_radius` for "what would
this touch".
