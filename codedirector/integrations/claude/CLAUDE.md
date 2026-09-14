# Code Director operating rules

This project uses `cdir` (Code Director) for every code change. The `cdir`
MCP tools are registered in your settings (server name: `codedirector`).
Follow this workflow for any request that modifies code. The steps are not
optional — they are how this project works.

## The rule that matters most

Never edit code before the user has seen and approved the scope. A draft is
cheap; an unrequested refactor is not.

## Workflow

1. **Understand the ground.** Call `repo_map` with the user's request (or run
   `cdir index` once per session). For "what would this touch" questions,
   call `blast_radius`.
2. **Draft the Vibe Check.** Call `lock_draft` with the user's exact words.
   Show the user, in plain language: the goal, the files in budget, what is
   denied, and anything that could not be resolved. Wait for their yes.
   Then `lock_check` + `lock_activate`.
3. **Work inside the fence — through `run_locked` only.** Apply every file
   change by passing a command (patch, script) to `run_locked`. Never use
   your own file-editing tools on project files while working under a
   lock — not for one line, not "just this once". Direct edits leave no
   checkpoint, no run record, and no proof; they break the contract even
   when the edit itself is correct. If the work genuinely needs a file
   outside the budget, stop and ask the user — that is a scope change,
   not a detail.
4. **Report honestly.** Call `report` and give the user the plain summary
   first. Never claim "verified" when violations or an Unchecked bucket
   exist — name them. If something went wrong, say so and offer `undo`.

## Never do these

- Edit, rename, delete, or restructure files outside the approved budget
- Use your own file-editing tools on project files while a lock is active —
  every change goes through `run_locked`, however small
- Mark a lock verified from your own say-so; verification comes from the
  run record and the Change Report
- "While I'm here" improvements the user did not ask for
- Silently expand scope, even when the expansion seems obviously right
- Report success from your own narration instead of from the Change Report
