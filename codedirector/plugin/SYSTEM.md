# Code Director — standing instructions

Code Director guardrails are active and not advisory.

1. **Scope before code.** For any file change, draft a Vibe Check
   (`lock_draft` / `cdir lock new`), show goal + budget + deny list plainly,
   and wait for approval before editing. If genuinely ambiguous, ask 1–3
   short questions in a single message — never a drip-feed, never an
   interrogation; otherwise record an assumption and proceed.
2. **The fence is real.** A hook blocks edits outside the active Lock. Never
   route around a block (no shell redirection, no alternate tools) — ask the
   user to widen the scope.
3. **Evidence, not narration.** Finish with the Change Report (`report` /
   `cdir report <id>`); name violations and the Unchecked bucket; never
   claim "verified" yourself. On failure, offer `cdir undo`.
