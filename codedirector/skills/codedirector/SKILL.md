---
name: codedirector
description: Agree on scope before editing code, then prove what changed. Use when the user asks you to modify, refactor, fix, or build anything in a repository — draft a Vibe Check (scope contract) with cdir, get the user's confirmation, work inside it, and finish with a Change Report. Prevents scope creep, unrequested renames and restructuring, and unverified "done" claims.
---

# Code Director workflow

You have the `cdir` command available (or the equivalent MCP tools). It turns a
vague request into an agreed scope, watches what the work actually touches, and
reports what it could verify — and what it could not. Follow this workflow for
every code-change request. Do not skip steps to save time; the steps are the
product.

## The rule that matters most

**Never edit code before the user has seen and approved the scope.** A draft is
cheap; an unrequested refactor is not. When in doubt, the budget stays small.

## Workflow

### 1. Understand the ground (once per session)

```
cdir index
cdir map "<the user's request, in their words>"
```

Read the map before proposing anything. If the user asks what a change might
affect, use `cdir why <symbol>` — it gives the blast radius directly.

### 2. Draft the Vibe Check

```
cdir lock new "<the user's exact words>" --goal "<what done means>"
```

Then **show the draft to the user in plain language**: the goal, the files in
budget, what is denied, and what the tool could not resolve. Ask for
confirmation. If the user adjusts the scope, edit the YAML at
`.codedirector/locks/IL-*.yaml` — it is meant to be human-editable.

Only after the user says yes:

```
cdir lock check IL-XXXX && cdir lock activate IL-XXXX
```

### 3. Do the work inside the fence

Run the change through the guardrail, never bare:

```
cdir run IL-XXXX -- <the command that makes the change>
```

If you are editing files directly (no single command), take a checkpoint first
(`cdir checkpoint`), edit only files inside the budget, then `cdir verify
IL-XXXX`. If the work genuinely needs a file outside the budget, **stop and ask
the user** — that is a scope change, not a detail.

### 4. Report, honestly

```
cdir report IL-XXXX
```

Give the user the plain summary first, then the detail. Never claim "verified"
when the report lists violations or an Unchecked bucket — name them. If
something went wrong, say so and offer `cdir undo`.

## What counts as a violation (never do these)

- Editing, renaming, deleting, or restructuring files outside the approved budget
- "While I'm here" improvements the user did not ask for
- Silently expanding scope, even when the expansion seems obviously right
- Reporting success from your own narration instead of from `cdir report`

## MCP tool equivalents

When connected via `cdir mcp`, the same workflow maps to tools:
`repo_map` → step 1, `lock_draft` / `lock_check` / `lock_activate` → step 2,
`run_locked` → step 3, `report` / `undo` → step 4. `blast_radius` answers
"what would this touch" questions.

## Tone with the user

Plain language, always. The user approved a scope and deserves a receipt, not a
narration: what changed, what stayed inside the agreement, what was checked,
what nobody could check.
