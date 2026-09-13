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

## Intake — spend nothing before the direction is set

A vague request ("make it better", "build something like X", "improve this")
gets questions and options FIRST — not research:

- Reply with 2–4 concrete directions, each with a one-line trade-off, and
  recommend one. Or ask 1–3 short questions in a single batch.
- **No tool calls before the user answers**: no web search, no repo scan,
  no MCP tools, no file reads. At most one directory listing so the options
  are grounded in what is actually here.
- Research (web, deep reads, blast radius) happens only AFTER the user
  picks a direction — and only as much as the Vibe Check draft needs.
- Request already clear? Skip the questions, record assumptions in the
  lock, proceed.

## Workflow

1. **Map** (only after the direction is set; once per session): `cdir index`
   + `cdir map "<the user's words>"`. Blast-radius questions:
   `cdir why <symbol>`.
2. **Draft, then mirror**: `cdir lock new "<exact words>" --goal "<what
   done means>"` FIRST — never propose a scope in chat that does not exist
   as a draft lock. Then show the user, in plain words: goal, budget, deny
   list, assumptions. No lock ids, no command names, no file paths they
   didn't already see — the user approves intent, not machinery. Any clear
   yes / ok / go-ahead immediately triggers
   `cdir lock check IL-XXXX && cdir lock activate IL-XXXX`, then work
   begins. The user must never have to name a lock or run a command.
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
