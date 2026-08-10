# intent-experiment

*In plain terms: people ask for code changes in messy, ambiguous ways, and
coding agents tend to guess instead of asking. This package tests, side by
side, whether inserting a small "intent layer" — which pins down what the
human actually meant before the agent acts — produces measurably better
behavior. Everything here is harness and evidence; the verdict lives in
EXPERIMENT.md.*

**A rigorous A/B benchmark for one question:** can an *intent layer* between a
messy human request and a coding agent produce better agent actions — fewer
misunderstandings, fewer unnecessary questions, fewer tokens, fewer unintended
changes?

> Human → Intent → Agent → Software, instead of Human → Prompt → Agent → Hope.

This package is the experiment harness only. The sibling `codedirector/`
project provides the repo index / ranked repo map (`cdir index`, `cdir map`)
used to build the intent layer's repo context; it is not modified.

## Design

```
messy request ──┬──► [A] agent (raw request verbatim)
                │
                └──► [B] intent layer ──► refinedDirective ──► agent (same agent)
                          │
                          ├─ repo context: cdir index + map (top ~15 symbols) + file tree
                          ├─ model call → Intent Object (strict JSON schema)
                          ├─ ambiguity gate: divergent? → ONE question, answered
                          │  by the task oracle (simulated user), directive recompiled
                          └─ records intentTokens, questionAsked
```

Both conditions then run **the same tool-loop agent** (read_file, write_file,
list_files, run_command with 60s timeout, done; max 12 turns) on a fresh temp
copy of the fixture repo, followed by measurement (git diff, oracle checks)
and judging (LLM judge + mechanical proxy).

### The Intent Object

```json
{
  "goal": "...", "observedProblem": "...", "keep": [], "deny": [],
  "desiredOutcome": "...", "unknowns": [],
  "interpretations": [{"reading": "...", "observableDifference": "..."}],  // >= 2
  "divergent": false,
  "question": null | {"text": "...", "options": [{"id","label"}], "recommended": "a"},
  "refinedDirective": "... assuming X ..."
}
```

At most ONE question per task. When `divergent` is false, the assumption made
must be stated inline in `refinedDirective` ("assuming X").

## Metrics

Per run: `unintendedChanges` (files changed outside `must_change` ∪ test
helpers, from git diff), `checksPass` (oracle shell checks, exit 0), `turns`,
`wallTime`, `agentTokens`, `intentTokens`, `questionAsked`, plus:

- **intentAccuracy (0-1)** — LLM-judged: a separate model call scores the
  final diff against the task's 3-5 binary rubric criteria. Always labeled
  LLM-judged.
- **mechanical proxy** — `checksPass && unintendedChanges == 0`. The report
  never rests on the judge alone.

`questionNecessary` is scored against the oracle's `question_necessary`
label: unnecessary questions (asked when not needed) and missed questions
(needed but not asked) are counted separately in the analysis.

## Fixtures & tasks

- `fixtures/image-preview/` — slider → pipeline → preview/export toy
  (adapted from `codedirector/examples/demo-repo` for Node 24 native TS).
- `fixtures/task-list/` — tiny JSON task-list CLI (`add`/`list`/`done`),
  a cached fast path (`cache.ts`) and a slow path (`storage.ts`), with one
  deliberately planted subtle bug: `completeTask` indexes the raw
  insertion-ordered array instead of the displayed (newest-first) list.
- `benchmark/tasks/*.yaml` — 9 tasks with messy requests ("make this feel
  faster", "fix it", "make it like the other screen", "clean this up",
  "don't change anything else", "something broke after the last change",
  "make it production ready", "the export is wrong sometimes", "it's slow
  with lots of tasks"). Each has an oracle: `setup` (e.g. a commit that
  "broke" something), `must_change`/`must_not_change`, `checks` (shell
  commands that must exit 0), `question_answer` (simulated user),
  `question_necessary`, and a binary `rubric` for the judge.
  Setup/check helpers live in `benchmark/setup/*.mjs` / `benchmark/checks/*.mjs`;
  `{BENCH}` in YAML commands is substituted with the benchmark dir.

## How to run

```sh
npm install
npm test                              # unit tests — fully offline (mock backend)
npm run bench -- --pilot --mock       # offline demo of the whole pipeline
npm run bench -- --pilot              # live: 4 tasks × 2 conditions
npm run bench -- --full --repeats 5   # live: 9 tasks × 2 × 5
npm run bench -- --task t02-fix-it    # single task
npm run analyze                       # re-render results.json/results.md
```

Backend config: `OPENAI_BASE_URL` (default `https://api.openai.com/v1`),
`OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o`). `MOCK_BACKEND=1` or
`--mock` forces the deterministic scripted mock (no network).

Outputs land in `results/`: `results.raw.json` (per-run records),
per-run trajectories in `results/runs/`, and `results.json`/`results.md`
(paired per-task table, aggregates, the four "fewers").

Provenance: every run record carries its own `mock` boolean, stamped at run
creation. The top-level `mock` flag in `results.raw.json` / `results.json`
is computed from the records — true when ANY record used the mock backend —
never from invocation flags; a mixed set is labeled "MIXED — k of n records"
with an explicit caveat.

## Honest limits

- **LLM judge.** intentAccuracy is judged by a model and labeled as such;
  every report also shows the mechanical proxy so conclusions never rest on
  the judge alone.
- **n=1.** With one run per cell, results are a **pilot signal, not proof** —
  variance is unmeasured. Use `--repeats N` (N≥5) before concluding.
- **Simulated user.** Clarification answers come from the task oracle, not a
  real human; real users are less consistent and less cooperative.
- **Small fixtures.** Two toy repos and nine tasks cannot represent real
  codebases; this measures the plumbing and the direction of the effect.
- **Backend variance.** Token counts depend on the model's behavior; the mock
  backend's token counts are character-based estimates, usable only for
  harness testing.

## Layout

```
src/backend.ts   OpenAI-compatible chat + tool calling + deterministic mock
src/intent.ts    intent layer: repo context, Intent Object schema, ambiguity gate
src/agent.ts     tool-loop agent (identical for both conditions) + repo prep
src/measure.ts   git-diff metrics, oracle checks, mechanical proxy
src/judge.ts     LLM rubric judge (labeled LLM-judged)
src/run.ts       paired runner (--pilot/--full/--repeats/--mock)
src/analyze.ts   results.json + results.md
test/            node:test unit tests (offline)
```
