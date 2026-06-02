# Code Director intent-layer experiment — results

Generated: 2026-09-11T17:13:55.949Z · mock backend: false

> **Pilot signal, not proof.** n=1 per cell; variance is unmeasured. Run with `--repeats N` (N≥5) before concluding anything.

## Headline: the four "fewers"

1. **Fewer misunderstandings** — A mechanical-proxy 1.00 vs B 1.00; LLM-judged intent accuracy A 0.75 vs B 1.00.
2. **Fewer unnecessary questions** — B asked questions in 100% of runs; 1 unnecessary, 0 missed (per oracle necessity labels). A asks none by construction.
3. **Fewer tokens** — mean agent tokens A 13276 vs B 22243; B additionally spends 3973 intent tokens (total A 13276 vs B 26216).
4. **Fewer unintended changes** — mean unintended changed files A 0.00 vs B 0.00.

\* judge acc = mean rubric pass fraction, LLM-judged. proxy = mechanical (checksPass AND zero unintended changes).

## Per-task table

| task | cond | checks | unintended | turns | wall s | agent tok | intent tok | asked? | judge acc* | proxy |
|---|---|---|---|---|---|---|---|---|---|---|
| t02-fix-it | A | 100% | 0.0 | 8.0 | 75.7 | 13276 | 0 | 0% | 0.75 | 100% |
| t02-fix-it | B | 100% | 0.0 | 8.0 | 90.6 | 22243 | 3973 | 100% | 1.00 | 100% |

## Aggregates

| metric | A (raw request) | B (intent layer) |
|---|---|---|
| checks pass rate | 100% | 100% |
| mean unintended changes | 0.00 | 0.00 |
| mean turns | 8.0 | 8.0 |
| mean wall time (s) | 75.7 | 90.6 |
| mean agent tokens | 13276 | 22243 |
| mean intent tokens | 0 | 3973 |
| mean total tokens | 13276 | 26216 |
| mechanical proxy rate | 100% | 100% |
| LLM-judged intent accuracy | 0.75 | 1.00 |

## Caveats

- n=1 per cell: this is a PILOT SIGNAL, NOT PROOF. Variance is unmeasured; run --repeats N (N≥5) before drawing conclusions.
- Intent accuracy is LLM-judged — labeled as such; the mechanical proxy (checksPass && zero unintended changes) is reported alongside so the conclusion never rests on the judge alone.
- Clarification answers come from a simulated user (the task oracle), not a real human.
- Identical agent, prompts, and tools in both conditions; only the instruction differs.
