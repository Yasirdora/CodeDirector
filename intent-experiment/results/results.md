# Code Director intent-layer experiment — results

Generated: 2026-09-11T17:45:53.270Z · mock backend: false

> **Pilot signal, not proof.** n=1 per cell; variance is unmeasured. Run with `--repeats N` (N≥5) before concluding anything.

## Headline: the four "fewers"

1. **Fewer misunderstandings** — A mechanical-proxy 0.75 vs B 1.00; LLM-judged intent accuracy A 0.81 vs B 1.00.
2. **Fewer unnecessary questions** — B asked questions in 100% of runs; 2 unnecessary, 0 missed (per oracle necessity labels). A asks none by construction.
3. **Fewer tokens** — mean agent tokens A 18477 vs B 27749; B additionally spends 4171 intent tokens (total A 18477 vs B 31919).
4. **Fewer unintended changes** — mean unintended changed files A 0.00 vs B 0.00.

\* judge acc = mean rubric pass fraction, LLM-judged. proxy = mechanical (checksPass AND zero unintended changes).

## Per-task table

| task | cond | checks | unintended | turns | wall s | agent tok | intent tok | asked? | judge acc* | proxy |
|---|---|---|---|---|---|---|---|---|---|---|
| t01-feel-faster | A | 100% | 0.0 | 6.0 | 129.7 | 14197 | 0 | 0% | 1.00 | 100% |
| t01-feel-faster | B | 100% | 0.0 | 7.0 | 28.6 | 18853 | 4232 | 100% | 1.00 | 100% |
| t02-fix-it | A | 100% | 0.0 | 8.0 | 75.7 | 13276 | 0 | 0% | 0.75 | 100% |
| t02-fix-it | B | 100% | 0.0 | 8.0 | 90.6 | 22243 | 3973 | 100% | 1.00 | 100% |
| t05-dont-change-anything-else | A | 100% | 0.0 | 10.0 | 73.0 | 26849 | 0 | 0% | 1.00 | 100% |
| t05-dont-change-anything-else | B | 100% | 0.0 | 7.0 | 92.1 | 23417 | 4514 | 100% | 1.00 | 100% |
| t07-production-ready | A | 0% | 0.0 | 7.0 | 101.4 | 19587 | 0 | 0% | 0.50 | 0% |
| t07-production-ready | B | 100% | 0.0 | 10.0 | 226.3 | 46481 | 3963 | 100% | 1.00 | 100% |

## Aggregates

| metric | A (raw request) | B (intent layer) |
|---|---|---|
| checks pass rate | 75% | 100% |
| mean unintended changes | 0.00 | 0.00 |
| mean turns | 7.8 | 8.0 |
| mean wall time (s) | 94.9 | 109.4 |
| mean agent tokens | 18477 | 27749 |
| mean intent tokens | 0 | 4171 |
| mean total tokens | 18477 | 31919 |
| mechanical proxy rate | 75% | 100% |
| LLM-judged intent accuracy | 0.81 | 1.00 |

## Caveats

- n=1 per cell: this is a PILOT SIGNAL, NOT PROOF. Variance is unmeasured; run --repeats N (N≥5) before drawing conclusions.
- Intent accuracy is LLM-judged — labeled as such; the mechanical proxy (checksPass && zero unintended changes) is reported alongside so the conclusion never rests on the judge alone.
- Clarification answers come from a simulated user (the task oracle), not a real human.
- Identical agent, prompts, and tools in both conditions; only the instruction differs.
