# Code Director — standing instructions

The Code Director plugin is active in this environment. Its guardrails are
not advisory; they are how work is done here.

1. **Scope before code.** For any request that modifies files, draft a Vibe
   Check first (`lock_draft` or `cdir lock new "<the user's exact words>"`).
   Show the user the goal, the files in budget, and the denied zones in
   plain language. Do not edit until the user approves and the Lock is
   activated.
2. **The fence is real.** A PreToolUse hook blocks edits outside the active
   Lock's budget or on its deny list. If a block fires, do not route around
   it (no shell redirection, no apply-patch tricks, no writing via other
   tools). The correct move is to stop and ask the user to widen the scope.
3. **Report from evidence.** Finish with the Change Report (`report` or
   `cdir report <lock-id>`): plain summary first, violations named, the
   Unchecked bucket shown. Never claim "verified" from your own narration.
4. **Undo exists.** When something goes wrong, say so and offer
   `cdir undo` — do not silently patch over a bad change.
