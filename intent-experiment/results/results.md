# Code Director intent-layer experiment — results

Generated: 2026-09-11T17:07:44.212Z · mock backend: true

> **Pilot signal, not proof.** n=1 per cell; variance is unmeasured. Run with `--repeats N` (N≥5) before concluding anything.

## Headline: the four "fewers"

1. **Fewer misunderstandings** — A mechanical-proxy 0.00 vs B 0.00; LLM-judged intent accuracy A n/a (judge could not parse) vs B n/a (judge could not parse).
2. **Fewer unnecessary questions** — B asked questions in 0% of runs; 0 unnecessary, 0 missed (per oracle necessity labels). A asks none by construction.
3. **Fewer tokens** — mean agent tokens A 130 vs B 141; B additionally spends 912 intent tokens (total A 130 vs B 1053).
4. **Fewer unintended changes** — mean unintended changed files A 0.00 vs B 0.00.

\* judge acc = mean rubric pass fraction, LLM-judged. proxy = mechanical (checksPass AND zero unintended changes).

## Per-task table

| task | cond | checks | unintended | turns | wall s | agent tok | intent tok | asked? | judge acc* | proxy |
|---|---|---|---|---|---|---|---|---|---|---|
| t02-fix-it | A | 0% | 0.0 | 1.0 | 0.0 | 130 | 0 | 0% | n/a | 0% |
| t02-fix-it | B | 0% | 0.0 | 1.0 | 0.0 | 141 | 912 | 0% | n/a | 0% |

## Aggregates

| metric | A (raw request) | B (intent layer) |
|---|---|---|
| checks pass rate | 0% | 0% |
| mean unintended changes | 0.00 | 0.00 |
| mean turns | 1.0 | 1.0 |
| mean wall time (s) | 0.0 | 0.0 |
| mean agent tokens | 130 | 141 |
| mean intent tokens | 0 | 912 |
| mean total tokens | 130 | 1053 |
| mechanical proxy rate | 0% | 0% |
| LLM-judged intent accuracy | n/a | n/a |

## Caveats

- n=1 per cell: this is a PILOT SIGNAL, NOT PROOF. Variance is unmeasured; run --repeats N (N≥5) before drawing conclusions.
- Intent accuracy is LLM-judged — labeled as such; the mechanical proxy (checksPass && zero unintended changes) is reported alongside so the conclusion never rests on the judge alone.
- Clarification answers come from a simulated user (the task oracle), not a real human.
- Identical agent, prompts, and tools in both conditions; only the instruction differs.
