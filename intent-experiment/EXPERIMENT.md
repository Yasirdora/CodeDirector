# EXPERIMENT.md — Can an intent layer turn messy human requests into better coding-agent actions?

*In plain terms: we gave the same nine messy requests to the same coding agent
twice — once raw, once after an intent layer clarified what was wanted — and
measured the difference. Clarifying first eliminated every misunderstanding we
observed, but cost noticeably more tokens and a few unnecessary questions. The
details, and why this is a signal rather than proof, follow.*

**One research question:** can we consistently take messy human requests and turn them into
better coding-agent actions — with fewer misunderstandings, fewer unnecessary questions, fewer
tokens, and fewer unintended changes?

The thesis under test: **Human → Intent → Agent → Software** instead of
**Human → Prompt → Agent → Hope**.

**Verdict up front (pilot signal, not proof):** on 9 paired tasks, the intent layer eliminated
both observed misunderstanding failures (7/9 → 9/9 on the mechanical proxy), at the price of
**more** tokens (+72% total), slightly **more** questions than necessary (3 of 9 runs asked a
question the oracle labels unnecessary), and no difference in unintended changes (both
conditions were clean). The thesis is supported on the correctness axis, contradicted on the
token axis, and unproven overall at n=1 per cell. See "What would count as proof" below.

## Method

### Conditions

- **A (control):** the coding agent receives the messy request verbatim.
- **B (treatment):** an intent layer first compiles the request into an Intent Object
  (strict JSON schema: goal, observedProblem, keep[], deny[], desiredOutcome, unknowns[],
  ≥2 interpretations with observable differences, divergent flag, at most ONE clarification
  question with 2–4 options + recommendation, refinedDirective). If `divergent`, the question
  is answered by the task oracle (simulated user) and the directive recompiled with the answer;
  if not, the assumption must be stated inline ("assuming X"). The agent then receives only the
  refinedDirective.

### Harness

Identical tool-loop agent in both conditions (read_file, write_file, list_files, run_command
with 60s timeout, done; max 12 turns), operating on a fresh temp copy of the fixture repo per
run; oracle `setup` (e.g. a commit that "broke" something) is applied and committed before the
run, so the post-run git diff measures only the agent's changes. Intent-layer repo context is
the cdir (codedirector) ranked repo map, top ~15 symbols, 900-token budget + file tree — kept
small deliberately, as part of the token story. Backend: `gpt-4o` via an OpenAI-compatible
endpoint, default temperature (the model rejects non-default values), no SDK. The full harness
also runs offline against a deterministic mock backend (`npm test`, 22 unit tests, no network).

### Metrics

Per run: `checksPass` (oracle shell checks must exit 0 in the final repo), `unintendedChanges`
(files changed outside `must_change` ∪ test helpers, from git diff), `turns`, `wallTime`,
`agentTokens`, `intentTokens`, `questionAsked` vs oracle-labeled `questionNecessary`,
`judgeAccuracy` (0–1, mean of 3–5 binary rubric criteria scored by a separate LLM call over the
diff — **LLM-judged, labeled as such**), and a **mechanical proxy** = checksPass ∧ zero
unintended changes, so no conclusion rests on the judge alone.

### Oracle design

9 tasks over 2 toy TypeScript repos: `image-preview` (slider → pipeline → preview/export) and
`task-list` (JSON CLI: add/list/done, cached fast path, one deliberately planted subtle bug —
`done <n>` indexes the insertion-ordered array instead of the displayed newest-first list).
Messy requests drawn from real-world vagueness: "make this feel faster", "fix it" (failing test
present), "make it like the other screen", "clean this up", "don't change anything else"
(in-scope bug), "something broke after the last change" (setup commit plants the regression),
"make it production ready", "the export is wrong sometimes" (setup removes the intensity
clamp), "it's slow with lots of tasks". Each oracle defines `must_change`, `must_not_change`,
`checks`, a `question_answer` (the simulated user's answer), a `question_necessary` label, and
a 3–5 criterion binary rubric.

## Results (n=1 per cell — pilot signal, not proof)

| task | cond | checks | unintended | turns | agent tok | intent tok | asked? | necessary? | judge acc* | proxy |
|---|---|---|---|---|---|---|---|---|---|---|
| t01-feel-faster | A | ✅ | 0 | 6 | 14,197 | 0 | n | Y | 1.00 | ✅ |
| t01-feel-faster | B | ✅ | 0 | 7 | 18,853 | 4,232 | Y | Y | 1.00 | ✅ |
| t02-fix-it | A | ✅ | 0 | 8 | 13,276 | 0 | n | n | 0.75 | ✅ |
| t02-fix-it | B | ✅ | 0 | 8 | 22,243 | 3,973 | Y | n | 1.00 | ✅ |
| t03-like-the-other-screen | A | ✅ | 0 | 7 | 11,514 | 0 | n | Y | 1.00 | ✅ |
| t03-like-the-other-screen | B | ✅ | 0 | 8 | 21,422 | 3,824 | Y | Y | 1.00 | ✅ |
| t04-clean-this-up | A | ✅ | 0 | 6 | 13,364 | 0 | n | Y | 1.00 | ✅ |
| t04-clean-this-up | B | ✅ | 0 | 9 | 32,301 | 3,736 | Y | Y | 1.00 | ✅ |
| t05-dont-change-anything-else | A | ✅ | 0 | 10 | 26,849 | 0 | n | n | 1.00 | ✅ |
| t05-dont-change-anything-else | B | ✅ | 0 | 7 | 23,417 | 4,514 | Y | n | 1.00 | ✅ |
| t06-something-broke | A | ✅ | 0 | 7 | 14,279 | 0 | n | n | 0.75 | ✅ |
| t06-something-broke | B | ✅ | 0 | 10 | 36,225 | 4,415 | Y | n | 0.50 | ✅ |
| t07-production-ready | A | ❌ | 0 | 7 | 19,587 | 0 | n | Y | 0.50 | ❌ |
| t07-production-ready | B | ✅ | 0 | 10 | 46,481 | 3,963 | Y | Y | 1.00 | ✅ |
| t08-export-wrong-sometimes | A | ❌ | 0 | 7 | 16,137 | 0 | n | Y | 1.00 | ❌ |
| t08-export-wrong-sometimes | B | ✅ | 0 | 6 | 17,005 | 4,536 | Y | Y | 1.00 | ✅ |
| t09-many-tasks-slow | A | ✅ | 0 | 11 | 40,010 | 0 | n | Y | 0.75 | ✅ |
| t09-many-tasks-slow | B | ✅ | 0 | 10 | 35,059 | 4,127 | Y | Y | 0.75 | ✅ |

\* judge acc = mean rubric pass fraction, **LLM-judged**. proxy = mechanical
(checksPass ∧ zero unintended changes).

### Aggregates

| metric | A (raw request) | B (intent layer) | Δ |
|---|---|---|---|
| checks pass rate | 7/9 (78%) | 9/9 (100%) | **+2 tasks** |
| mean unintended changes | 0 | 0 | 0 |
| mean turns | 7.7 | 8.3 | +0.7 |
| mean wall time | 85 s | 92 s | +7 s |
| mean agent tokens | 18,801 | 28,112 | **+49%** |
| mean intent tokens | 0 | 4,147 | +4,147 |
| mean total tokens | 18,801 | 32,258 | **+72%** |
| mechanical proxy rate | 78% | 100% | +22 pp |
| LLM-judged intent accuracy | 0.86 | 0.92 | +0.06 |
| questions asked | 0/9 (by construction) | 9/9 | — |
| unnecessary questions | 0 | **3** (t02, t05, t06) | — |
| missed needed questions | **6** | 0 | — |

## The four "fewers", answered

1. **Fewer misunderstandings — supported (pilot signal).** Both A-condition failures were
   textbook "Hope" failures, and both were fixed by the intent layer:
   - *t07 "make this production ready":* A ran off and fixed the planted done-index bug (a
     plausible but unrequested reading); B's gate asked, the oracle answered "validation and
     graceful errors only", and the directive narrowed scope exactly — checks passed.
   - *t08 "the export is wrong sometimes":* A guessed byte-overflow and clamped output bytes to
     0..255 — a plausible-but-wrong root cause; the oracle check catches it. B asked, got
     "clamp intensity to 0..1 in the pipeline", and fixed the actual regression.
2. **Fewer unnecessary questions — contradicted (calibration gap).** B asked in 9/9 runs; the
   oracle says 3 were unnecessary (t02 "fix it", t05 "don't change anything else", t06
   "something broke" — all narrow, unambiguous tasks). The gate over-triggers `divergent`.
   Still, B never missed a needed question; A missed 6 by construction. The failure mode moved
   from "never asks" to "asks slightly too often" — a tunable calibration problem, not an
   architectural one.
3. **Fewer tokens — contradicted.** B costs +49% agent tokens (longer directives induce more
   verification work) plus 4.1k intent tokens, +72% total. The intent layer is a
   correctness-for-tokens trade at this scale. (Hypothesis for repeats: on tasks where A
   flails, B may be cheaper — t09 showed B below A. n=1 cannot settle this.)
4. **Fewer unintended changes — no signal.** Both conditions: zero unintended files on all 18
   runs. The toy repos plus explicit "don't touch" norms in the agent's system prompt leave no
   room for this metric to discriminate. Harder repos needed.

**Intent accuracy:** mechanical proxy 0.78 → 1.00; LLM-judged 0.86 → 0.92.

## Verdict

The pilot **supports the direction of the thesis**: an intent layer with a one-question
ambiguity gate converted two genuine misinterpretation failures into successes, and never made
a passing task fail. It **refutes the "fewer tokens" hope** at this scale, and its question
gate is miscalibrated toward asking. As stated — *measurably better across all four "fewers"* —
the thesis is **not supported**: it is better where it matters most (understanding) and worse
where it costs (tokens, question discipline). Honest framing: "Human → Intent → Agent →
Software" looks like a **correctness upgrade you pay for in tokens**, not a free lunch.

This is a pilot signal, not proof: n=1 per cell, variance unmeasured.

## What would count as proof

- **Repeats:** ≥5 per cell (90 runs) with means + spread per metric; a paired test on proxy and
  tokens. Current differences (proxy 78% vs 100%; tokens +72%) need confidence intervals.
- **Question-gate calibration:** measure precision/recall of `divergent` against oracle
  necessity across repeats; target: ask on t01/t03/t04/t07/t08/t09-class tasks, abstain on
  t02/t05/t06-class tasks.
- **Harder fixtures:** repos where unintended-change and blast-radius metrics can actually move.
- **Model diversity:** at least one other model family as agent, and a different judge model.

## Threats to validity

- **Simulated user.** Clarification answers come from the task oracle — always available,
  always coherent, always aligned with the hidden checks. Real users answer late, vaguely, or
  inconsistently; B's advantage on t07/t08 is probably an upper bound.
- **Single model family as intent compiler, agent, AND judge** (all `gpt-4o`). The judge may
  share the agent's blind spots. Observed concretely: t08-A received judge accuracy **1.00**
  while failing the mechanical check (the judge accepted byte-clamping as "the root cause") —
  a judge false positive; conversely t06-B scored 0.50 while passing everything (strictness
  noise). The mechanical proxy exists precisely because of this.
- **Toy repos.** Two fixtures of 4–5 source files; the repo map covers them nearly whole.
  Nothing here measures whether the intent layer scales to repos where context selection is
  the hard part.
- **Experimenter-designed tasks.** The messy requests, the "necessary question" labels, and the
  checks all encode the experimenters' intended reading. A task whose oracle disagrees with
  what a real user meant would invert a result.
- **n=1, no variance.** Any single-run difference could be sampling noise; model decoding at
  default temperature is stochastic.
- **Selection in failure analysis.** The two A-failures were chosen for narrative clarity;
  they are also the *only* two, which is the entire quantitative signal.

## Reproduce

```sh
cd intent-experiment
npm install && npm test                 # 22 unit tests, offline
npm run bench -- --full --mock          # offline pipeline demo
npm run bench -- --full                 # live (resumes; per-run upsert into results.raw.json)
npm run analyze                         # re-render results.json / results.md
```

Raw records: `results/results.raw.json`; per-run trajectories + diffs: `results/runs/`;
rendered report: `results/results.md`.
