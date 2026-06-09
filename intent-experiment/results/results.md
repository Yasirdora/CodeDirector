# Code Director intent-layer experiment — results

Generated: 2026-09-11T18:14:18.925Z · mock backend: false

> **Pilot signal, not proof.** n=1 per cell; variance is unmeasured. Run with `--repeats N` (N≥5) before concluding anything.

## Headline: the four "fewers"

1. **Fewer misunderstandings** — A mechanical-proxy 0.78 vs B 1.00; LLM-judged intent accuracy A 0.86 vs B 0.92.
2. **Fewer unnecessary questions** — B asked questions in 100% of runs; 3 unnecessary, 0 missed (per oracle necessity labels). A asks none by construction.
3. **Fewer tokens** — mean agent tokens A 18801 vs B 28112; B additionally spends 4147 intent tokens (total A 18801 vs B 32258).
4. **Fewer unintended changes** — mean unintended changed files A 0.00 vs B 0.00.

\* judge acc = mean rubric pass fraction, LLM-judged. proxy = mechanical (checksPass AND zero unintended changes).

## Per-task table

| task | cond | checks | unintended | turns | wall s | agent tok | intent tok | asked? | judge acc* | proxy |
|---|---|---|---|---|---|---|---|---|---|---|
| t01-feel-faster | A | 100% | 0.0 | 6.0 | 129.7 | 14197 | 0 | 0% | 1.00 | 100% |
| t01-feel-faster | B | 100% | 0.0 | 7.0 | 28.6 | 18853 | 4232 | 100% | 1.00 | 100% |
| t02-fix-it | A | 100% | 0.0 | 8.0 | 75.7 | 13276 | 0 | 0% | 0.75 | 100% |
| t02-fix-it | B | 100% | 0.0 | 8.0 | 90.6 | 22243 | 3973 | 100% | 1.00 | 100% |
| t03-like-the-other-screen | A | 100% | 0.0 | 7.0 | 29.4 | 11514 | 0 | 0% | 1.00 | 100% |
| t03-like-the-other-screen | B | 100% | 0.0 | 8.0 | 107.4 | 21422 | 3824 | 100% | 1.00 | 100% |
| t04-clean-this-up | A | 100% | 0.0 | 6.0 | 60.2 | 13364 | 0 | 0% | 1.00 | 100% |
| t04-clean-this-up | B | 100% | 0.0 | 9.0 | 88.6 | 32301 | 3736 | 100% | 1.00 | 100% |
| t05-dont-change-anything-else | A | 100% | 0.0 | 10.0 | 73.0 | 26849 | 0 | 0% | 1.00 | 100% |
| t05-dont-change-anything-else | B | 100% | 0.0 | 7.0 | 92.1 | 23417 | 4514 | 100% | 1.00 | 100% |
| t06-something-broke | A | 100% | 0.0 | 7.0 | 56.4 | 14279 | 0 | 0% | 0.75 | 100% |
| t06-something-broke | B | 100% | 0.0 | 10.0 | 66.4 | 36225 | 4415 | 100% | 0.50 | 100% |
| t07-production-ready | A | 0% | 0.0 | 7.0 | 101.4 | 19587 | 0 | 0% | 0.50 | 0% |
| t07-production-ready | B | 100% | 0.0 | 10.0 | 226.3 | 46481 | 3963 | 100% | 1.00 | 100% |
| t08-export-wrong-sometimes | A | 0% | 0.0 | 7.0 | 68.4 | 16137 | 0 | 0% | 1.00 | 0% |
| t08-export-wrong-sometimes | B | 100% | 0.0 | 6.0 | 53.1 | 17005 | 4536 | 100% | 1.00 | 100% |
| t09-many-tasks-slow | A | 100% | 0.0 | 11.0 | 173.4 | 40010 | 0 | 0% | 0.75 | 100% |
| t09-many-tasks-slow | B | 100% | 0.0 | 10.0 | 73.6 | 35059 | 4127 | 100% | 0.75 | 100% |

## Aggregates

| metric | A (raw request) | B (intent layer) |
|---|---|---|
| checks pass rate | 78% | 100% |
| mean unintended changes | 0.00 | 0.00 |
| mean turns | 7.7 | 8.3 |
| mean wall time (s) | 85.3 | 91.8 |
| mean agent tokens | 18801 | 28112 |
| mean intent tokens | 0 | 4147 |
| mean total tokens | 18801 | 32258 |
| mechanical proxy rate | 78% | 100% |
| LLM-judged intent accuracy | 0.86 | 0.92 |

## Caveats

- n=1 per cell: this is a PILOT SIGNAL, NOT PROOF. Variance is unmeasured; run --repeats N (N≥5) before drawing conclusions.
- Intent accuracy is LLM-judged — labeled as such; the mechanical proxy (checksPass && zero unintended changes) is reported alongside so the conclusion never rests on the judge alone.
- Clarification answers come from a simulated user (the task oracle), not a real human.
- Identical agent, prompts, and tools in both conditions; only the instruction differs.
