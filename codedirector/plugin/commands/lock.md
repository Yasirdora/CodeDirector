---
description: Draft a Vibe Check for a request and wait for the user's approval
---

Draft a Vibe Check (scope contract) for this request: $ARGUMENTS

Steps:
1. Call `repo_map` with the user's words to ground yourself in the repository.
2. Call `lock_draft` with the user's exact words.
3. Show the draft in plain language: the goal, the files in budget, the deny
   list, and anything that could not be resolved. Ask the user to confirm or
   adjust the scope.
4. Only after an explicit yes: `lock_check`, then `lock_activate`.

Do not edit any files during this command — the draft comes first, always.
