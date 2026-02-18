# Repo Analysis: `the seed repository` — Research Notes for "Code Director"

**Repo:** https://github.com/the seed repository (branch `main`)
**Status:** Accessible and substantive. Analyzed 2026-09-11 via the GitHub repo page, raw files, and the GitHub git-tree API.
**Verdict up front:** This is NOT an intent-translation tool. It is a single-response-style prompt pack (a ~7 KB `SKILL.md`) wrapped in an unusually polished multi-platform distribution shell and a surprisingly rigorous LLM-judged eval harness. It solves "AI assistants bury the answer in prose" — a *formatting/output* problem — not the *input* problem ("translate vague human intent into scoped technical execution") that Code Director targets. Its value to Code Director is as a catalog of interaction principles and as a model of honest evaluation; its architecture contributes almost nothing.

---

## What the repository actually is

The entire behavioral payload is one Markdown file, `skills/seed-repo/SKILL.md` (7,207 bytes), containing 10 output-formatting rules plus escape hatches. Everything else is distribution plumbing: plugin manifests for Claude Code, Codex, Cursor, OpenCode, Pi, OMP, Qwen, Gemini, Zed, Copilot, Hermes, Antigravity, AstronClaw; SessionStart hooks in `.mjs`/`.sh`/`.ps1`; a TypeScript extension for Pi/OMP; 6 localized READMEs and 5 localized INSTALL docs; CI workflows; and a Python eval harness (`scripts/run_evals.py`, `scripts/judge.py`) with 14 test cases and published results.

The README's own one-liner is accurate: *"A skill for your coding assistant that stops it from burying the answer. Action first. Steps numbered. No 'Hope this helps!'"* ([README.md](https://raw.githubusercontent.com/the seed repository/main/README.md))

---

## The 12 questions

### 1. What problem is it solving?

LLM coding assistants produce responses padded with preamble ("Great question!"), tangents ("By the way, your dependency is also stale"), vague sequencing, and closers ("Hope this helps!"). For a reader with attention-load-style attention constraints — but the repo explicitly says *"attention-load-friendly outputs. No attention-load diagnosis needed!"* — this friction "is where work dies." The SKILL.md frames five cognitive facts as the design basis, e.g. *"Working memory is small. Anything not on screen is forgotten"* and *"Starting is the hardest step. The first action must be obvious, small, and doable now."* (SKILL.md)

It is purely an **output-shaping** problem. Nothing in the repo touches the input side: understanding what the user wants, detecting ambiguity in the request before acting, or managing scope.

### 2. What assumptions does it make?

- **The user can execute.** Rules assume a technically capable reader who can "Run `npm install jsonwebtoken@latest`, then edit `src/auth.ts:42`" — the opposite of Code Director's assumed non-technical user.
- **The intent is already clear.** Ambiguity is handled in exactly one escape hatch (*"Real ambiguity in the request. One short clarifying question beats guessing and rewriting"*), and it is the thinnest part of the ruleset. There is no model of *what* is ambiguous or *how much* ambiguity justifies blocking.
- **Session-scoped, single-agent context.** State is "a flag file and an injected ruleset," e.g. `touch ~/.claude/.seed-repo-always` toggles always-on mode. No persistence model beyond a session, no memory of prior tasks.
- **Prose is the bottleneck.** The whole theory of change is that reformatting text output fixes the interaction. The repo never questions whether the underlying task decomposition was correct.
- **Prompt injection is sufficient.** It assumes the model will follow the style rules if injected; there is no enforcement mechanism beyond evals run at development time.
- **The operator's harness is benign.** Eval docs acknowledge leakage risk: *"without it, user-level plugins, hooks, memory, and output styles leak into every condition"* ([evals/README.md](https://raw.githubusercontent.com/the seed repository/main/evals/README.md)) — i.e., they know prompt-level styling is fragile and environment-dependent.

### 3. What interaction principles does it contain?

The 10 rules, verbatim headings (SKILL.md):

1. Lead with the next action
2. Number multi-step tasks
3. End with one concrete next action
4. Suppress tangents
5. Restate state every turn
6. Give specific time estimates
7. Make completed work visible
8. Matter-of-fact tone for errors
9. Cap lists to 5 items
10. No preamble, no recap, no closing pleasantries

Plus a "When to break the rules" section that is arguably the most sophisticated part: explain fully when asked; confirm before destructive actions; *"Debug spiral. If the last three turns have been 'still broken,' stop iterating on code. Name the assumption that might be wrong. Ask one diagnostic question."*; one clarifying question for real ambiguity; the task outranks the shape; the harness outranks the skill.

And a **pre-send check** — a self-review rubric: *"if the reader reads only the first line and the last line, do they know (a) what to do next, and (b) what just happened?"* This is a cheap, effective output contract.

### 4. What ideas could generalize to coding?

- **Bounded step decomposition** ("No step contains 'and then' twice") is directly reusable for task plans generated from vague intent.
- **Explicit state restitution** ("step 3 of 5 done: schema updated") maps to Code Director's progress narration for non-technical users who cannot read logs.
- **The debug-spiral circuit breaker** (3 failed turns → stop, name the doubtful assumption, ask one question) is a genuine attention/cost budget mechanism and a guardrail against agentic thrash.
- **Destructive-action confirmation** as an inviolable override of brevity — safety outranks style.
- **Attention budgeting via presentation**: rule 9's nuance — *"This rule shapes presentation only; it must not limit analysis, search, tool results, candidate generation, or retained information"* — is exactly progressive disclosure: full computation internally, 5 items visible externally.
- **Kill the filler** (preamble/recap/closers, hedging adverbs, idioms) transfers verbatim.

### 5. What should Code Director borrow conceptually?

1. **The output contract as a first-class artifact.** The repo treats "how the assistant talks" as a versioned, testable spec (SKILL.md) rather than vibes. Code Director should treat its intent-translation behavior the same way: a written spec with escape hatches and a pre-send check.
2. **The escape-hatch pattern.** Rules with explicit, enumerated override conditions (destructive action, explain-request, ambiguity, debug spiral, harness conflict). Code Director's ambiguity detection needs exactly this: enumerated conditions under which the system must stop and ask instead of executing.
3. **First-line/last-line test.** For a non-technical user: first line = what happened or what's needed from you; last line = the single next thing. Adapted: first line = plain-language statement of what will be done; last line = the one decision the user must make.
4. **Eval-as-release-gate discipline** (details in Q9/Q11): blind A/B judging, dimension weights, resumable runs, and a willingness to publish a *failing* gate result.
5. **State restatement as an antidote to lost context** — for users who won't scroll up.

### 6. What should Code Director explicitly avoid?

- **The attention-load diagnosis framing as product identity** (see Q7) — for a commercial product it invites trivialization-of-disability criticism and narrows the perceived market.
- **One-shot prompt injection as the mechanism.** SKILL.md admits fragility indirectly — the Pi extension must *re-inject rules after compaction drops them* and track whether the ruleset is "still live in the context the model actually receives" (extensions/seed-repo.ts). Prompt-only behavior control is leaky; Code Director's scope control and ambiguity gates need structural enforcement (state machines, tool gating), not just instructions.
- **Rule 8's failure mode.** The repo's own evals found rule 8 *"pressures the model to name a cause even when the evidence does not identify one"* — the grader flagged a response that *"asserts 'missing auth header' as the definitive cause and prescribes a specific fix without any evidence"* ([evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)). Any style rule that mandates a confident structure can manufacture false confidence. Code Director must never let format requirements override calibrated uncertainty.
- **Absolute release gates.** Their gate rule "It has no blocking findings" means *"no candidate can ever pass while any blocker survives anywhere in the case set, however much it improves"* — a known-degenerate gate they shipped anyway.
- **Session-scope thinking.** Code Director needs cross-session scope/intent memory; flag files and "stays on until 'stop attention-load mode'" don't scale.

### 7. Is the attention-load framing actually necessary?

No — and the repo half-admits it. The tagline *"No attention-load diagnosis needed!"* and the credit line *"Adapted for how an LLM should respond, not how a human should organize their day"* ([README.md](https://raw.githubusercontent.com/the seed repository/main/README.md)) reveal the framing is a marketing hook and an organizing metaphor, not a functional requirement. Every rule would be equally valid for: busy executives, non-native speakers, mobile users, non-technical stakeholders, anyone in a hurry. The five "attention-load facts" (small working memory, initiation friction, time-estimate flattening, dopamine scarcity) are just... human cognition under load. The framing does real work in one place: it gives the ruleset a memorable identity and a defensible *reason* for ruthlessness ("this isn't rudeness, it's accessibility"). But it also caps the ceiling — nobody builds an enterprise product on a meme-named repo called `seed-repo`. For Code Director, the correct generalization is **cognitive-load-aware interaction design**, not a disability persona.

### 8. Is there a much larger market/problem hiding underneath it?

Yes, two of them:

1. **LLM output is systematically mismatched to human attention.** The repo's before/after table is a universal complaint about every chatbot. "Attention budgeting" as a productized layer — deciding what *not* to show — is underserved. Code Director's "progressive-disclosure explanations" is exactly this, generalized.
2. **The inverse problem is bigger still: input ambiguity.** This repo polishes answers to questions it assumes were understood. The harder, larger problem — Code Director's problem — is that non-technical users can't specify what they want, and assistants guess instead of detecting ambiguity. Nothing here addresses it (the `real-ambiguity` eval case is one case out of 14, criterion: *"Asks one concise blocking question rather than guessing"*). The gap this repo leaves is precisely Code Director's opening.

### 9. What technical approaches does the repository use?

- **Prompt engineering as the sole behavioral mechanism**: a YAML-frontmatter `SKILL.md` in the emerging cross-vendor "Agent Skills" format, with `disable-model-invocation: true` so it's opt-in via `/seed-repo`.
- **Hook-based injection**: a `SessionStart` hook ([hooks/always-on.mjs](https://raw.githubusercontent.com/the seed repository/main/hooks/always-on.mjs)) that checks for a flag file, strips frontmatter, and writes the ruleset to stdout for injection — with defensive design (*"Never block session start: any failure exits 0"*).
- **Session-state machines in the Pi extension**: custom context message types (`seed-repo-rules`, `seed-repo-disabled`), persistence via `sessionManager` entries, re-injection after compaction, stop-phrase interception, and a UI status indicator (`● attention-load ON`).
- **A genuinely serious LLM-eval harness**: 14 hand-labeled cases ([evals/cases.jsonl](https://raw.githubusercontent.com/the seed repository/main/evals/cases.jsonl)) spanning safety, ambiguity, progress reporting, casual messages; runner isolation (`--setting-sources ""` so operator config doesn't contaminate baselines); pinned models; per-condition dollar budgets; resumable runs keyed by `(case, trial, condition, runner)`; **structural blinding** — *"each condition is relabelled A/B/C before the prompt is built, and the label order is permuted per group"* with deterministic permutation *"from a digest of the group key rather than a random source"*; rubric markers (`<!-- judge:begin -->`) so condition-identifying release-gate text never reaches the grader; a 5-dimension weighted rubric (Correctness 35%, Autonomy 25%, Actionability 20%, Safety 10%, Concision 10%); and published results including a **FAILED release gate** ([evals/RESULTS.md](https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md)).
- **Multi-runtime packaging**: ~14 plugin manifests/adapters, sync CI (`cursor-skill-sync.yml`), unit tests for hooks, install docs, and eval scripts (`python3 -m unittest discover -s tests -v`).

### 10. What are its architectural limitations?

- **No enforcement layer.** Behavior is requested, not guaranteed. The mitigations (re-injection after compaction, disable notices) are acknowledgments that prompt context is unreliable memory.
- **Style-only scope.** No code analysis, no repo awareness, no tool use, no planning engine. It cannot detect ambiguity in a *task* — only advise the model to ask "one short question."
- **Binary on/off per session.** No per-rule tuning without forking and editing Markdown; no per-user profiles; no telemetry or feedback loop to learn which rules fire.
- **Self-judging evals.** The published results admit: *"One judge model, judging its own family. The grader is the same model that produced the responses"* — claude-opus-4-8 grading claude-opus-4-8. Also 3 trials, per-case SD up to 0.95, and *"Single-case deltas below roughly 0.5 should not be treated as signal."*
- **A broken eval case shipped in the gate**: `agent-owned-edit` *"cannot be passed by any run"* because runners pass `--tools ""`, yet it still counted toward the blocking-findings rule that failed the gate. Known-degenerate measurement wired into a release decision.
- **Distribution sprawl.** 14+ adapters, each with slightly different activation semantics (some honor `disable-model-invocation`, some don't — the INSTALL doc notes AstronClaw's behavior is *"not tested"*). Maintenance cost is high relative to the 7 KB payload.
- **No notion of cost/attention budgeting over time** — budgets exist only in the eval harness (dollar caps), not in the product behavior (e.g., "user has made 3 decisions this session; defer the rest").

### 11. Is anything in it genuinely novel?

Partially. The individual rules are standard "good technical writing" advice, and prompt-style packs are a crowded genre. The genuinely less-common elements:

1. **The explicit escape-hatch hierarchy** ("A rule fights the task. The task wins; the shape stays." / "A rule fights the harness. The constraint wins, the shape stays.") — a priority ordering among style, task, and platform constraints that most style prompts lack.
2. **The debug-spiral circuit breaker** — a turn-count-based metacognitive rule ("last three turns 'still broken' → name the assumption, ask one question"). This is a primitive form of attention/cost budgeting and is directly relevant to Code Director's scope control.
3. **Rule 9's internal/external split** — cap *presentation* at 5 items while explicitly forbidding the cap from touching analysis. Most "be concise" prompts conflate the two.
4. **The eval harness's structural blinding and its honesty** — deterministic A/B/C permutation, judge-visible rubric isolation, publishing a failing gate with a named mechanism for the one regression. Rare in the prompt-pack world; still only prompt-pack-grade science (self-judging, n=3).
5. **The "AI Agora"** — a labeled GitHub issue ([#127](https://github.com/the seed repository/issues/127)) where AI agents themselves may comment under rules in AGENTS.md. Novel as governance theater; unclear practical value.

Net: novel in *rigor and packaging*, not in *ideas*. The ideas are good; none were invented here except perhaps the debug-spiral rule as a prompt-level construct.

### 12. What would need to be redesigned from scratch for Code Director?

Nearly everything except the interaction principles:

- **Input-side intelligence (new).** The repo has no intent model. Code Director needs: intent parsing from plain language, explicit ambiguity detection with *taxonomy and thresholds* (not "one short question" as an afterthought), and clarification dialogues that a non-technical user can answer. Zero reusable code here.
- **Scope control (new).** Nothing in the repo constrains what the agent takes on. Need explicit scope contracts: what's in/out, change budgets, confirmation gates before expanding scope — enforced structurally (tool gating, plan approval), not by prompt.
- **Attention budgeting (redesign).** The repo's version is static (5-item cap, no preamble). Code Director needs a *dynamic* budget: track decisions requested, questions asked, tokens shown per session; degrade gracefully; escalate only what needs human judgment. Rule 9's presentation/analysis split is the seed; the accounting system doesn't exist.
- **Progressive disclosure (redesign).** "Explain fully when asked" is a manual toggle. Code Director needs layered explanations — plain-language summary → what changed → technical detail — with the user controlling depth, and defaults inferred from demonstrated expertise.
- **Persistence & state (new).** Replace flag files and session-scoped injection with durable per-user/per-project state: intent history, confirmed decisions, scope agreements across sessions.
- **Uncertainty handling (redesign).** Fix the failure mode their own evals found: never let format rules force fabricated causes. Confidence must be a first-class field in every claim Code Director makes, and low-confidence ambiguities must route to the user.
- **Evaluation (partially reusable conceptually, rebuilt in practice).** Keep the harness philosophy — blind comparison, weighted dimensions, isolation, published failures — but rebuild cases around *intent translation*: vague prompts, underspecified scope, non-technical phrasing, multi-turn clarification. Their 14 cases measure style; none measure whether the right thing got built.
- **Audience inversion.** The repo's assumed reader runs `npm test` themselves. Code Director's user doesn't know what npm is. Every example, time estimate, and "next action" pattern must be rewritten for execution-by-proxy: the user decides, the system does.

---

## Summary table: borrow vs. avoid vs. rebuild

| Element | Disposition for Code Director |
|---|---|
| 10 output rules (action-first, numbered steps, state restatement) | Borrow, adapted for non-technical users |
| Escape-hatch / rule-override hierarchy | Borrow the pattern; rewrite conditions around ambiguity & scope |
| Debug-spiral circuit breaker | Borrow; generalize into attention/cost budget enforcement |
| Rule 9 presentation-vs-analysis split | Borrow; it *is* progressive disclosure in embryo |
| Pre-send first-line/last-line check | Borrow as output contract |
| Eval harness philosophy (blind, weighted, isolated, honest) | Borrow philosophy; rebuild cases for intent translation |
| Prompt-injection-only mechanism | Avoid; use structural enforcement |
| attention-load framing as identity | Avoid; generalize to cognitive-load design |
| Rule 8 confident cause-naming | Avoid; confidence must be explicit, not formatted |
| Session-scope, flag-file state | Rebuild; durable cross-session intent/scope state |
| Ambiguity handling | Rebuild from scratch; it's a footnote here and the core of Code Director |

## Sources

- Repo page: https://github.com/the seed repository
- README: https://raw.githubusercontent.com/the seed repository/main/README.md
- SKILL.md (canonical rules): https://raw.githubusercontent.com/the seed repository/main/skills/seed-repo/SKILL.md
- AGENTS.md (repo map, AI Agora rules): https://raw.githubusercontent.com/the seed repository/main/AGENTS.md
- INSTALL.md (14+ platform adapters): https://raw.githubusercontent.com/the seed repository/main/INSTALL.md
- Always-on hook: https://raw.githubusercontent.com/the seed repository/main/hooks/always-on.mjs
- Pi extension (session state, compaction handling): https://raw.githubusercontent.com/the seed repository/main/extensions/seed-repo.ts
- Eval harness docs: https://raw.githubusercontent.com/the seed repository/main/evals/README.md
- Eval results (FAILED gate): https://raw.githubusercontent.com/the seed repository/main/evals/RESULTS.md
- Eval rubric: https://raw.githubusercontent.com/the seed repository/main/evals/rubric.md
- Eval cases: https://raw.githubusercontent.com/the seed repository/main/evals/cases.jsonl
- File tree: https://api.github.com/repos/the seed repository/git/trees/main?recursive=1
