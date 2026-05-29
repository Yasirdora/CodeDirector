"use strict";
/**
 * analyze.ts — turn results.raw.json into results.json + results.md.
 * Per-task paired table (A vs B on every metric), aggregates, and answers
 * to the four "fewers" + intent accuracy. With n=1 per cell the language
 * is "pilot signal, not proof".
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyze = analyze;
exports.renderMarkdown = renderMarkdown;
exports.analyzeFile = analyzeFile;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
function mean(xs) {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function rate(xs) {
    return xs.length ? xs.filter(Boolean).length / xs.length : 0;
}
function aggregate(records) {
    const judged = records.filter((r) => r.judgeAccuracy !== null);
    return {
        n: records.length,
        checksPassRate: rate(records.map((r) => r.checksPass)),
        unintendedMean: mean(records.map((r) => r.unintendedChanges.length)),
        turnsMean: mean(records.map((r) => r.turns)),
        wallTimeMeanMs: mean(records.map((r) => r.wallTimeMs)),
        agentTokensMean: mean(records.map((r) => r.agentTokens.total)),
        intentTokensMean: mean(records.map((r) => r.intentTokens.total)),
        totalTokensMean: mean(records.map((r) => r.agentTokens.total + r.intentTokens.total)),
        questionRate: rate(records.map((r) => r.questionAsked)),
        unnecessaryQuestions: records.filter((r) => r.questionAsked && r.questionNecessary === false).length,
        missedQuestions: records.filter((r) => !r.questionAsked && r.questionNecessary === true).length,
        judgeAccuracyMean: judged.length ? mean(judged.map((r) => r.judgeAccuracy)) : null,
        mechanicalProxyRate: rate(records.map((r) => r.mechanicalProxy)),
    };
}
function analyze(raw) {
    const byTask = new Map();
    for (const r of raw.records) {
        if (!byTask.has(r.taskId))
            byTask.set(r.taskId, []);
        byTask.get(r.taskId).push(r);
    }
    const perTask = [...byTask.entries()].sort().map(([taskId, rs]) => ({
        taskId,
        A: aggregate(rs.filter((r) => r.condition === "A")),
        B: aggregate(rs.filter((r) => r.condition === "B")),
    }));
    const A = aggregate(raw.records.filter((r) => r.condition === "A"));
    const B = aggregate(raw.records.filter((r) => r.condition === "B"));
    const fmtAcc = (x) => (x === null ? "n/a (judge could not parse)" : x.toFixed(2));
    const fewers = {
        misunderstandings: `A mechanical-proxy ${A.mechanicalProxyRate.toFixed(2)} vs B ${B.mechanicalProxyRate.toFixed(2)}; ` +
            `LLM-judged intent accuracy A ${fmtAcc(A.judgeAccuracyMean)} vs B ${fmtAcc(B.judgeAccuracyMean)}.`,
        unnecessaryQuestions: `B asked questions in ${(B.questionRate * 100).toFixed(0)}% of runs; ` +
            `${B.unnecessaryQuestions} unnecessary, ${B.missedQuestions} missed (per oracle necessity labels). A asks none by construction.`,
        tokens: `mean agent tokens A ${A.agentTokensMean.toFixed(0)} vs B ${B.agentTokensMean.toFixed(0)}; ` +
            `B additionally spends ${B.intentTokensMean.toFixed(0)} intent tokens (total A ${A.totalTokensMean.toFixed(0)} vs B ${B.totalTokensMean.toFixed(0)}).`,
        unintendedChanges: `mean unintended changed files A ${A.unintendedMean.toFixed(2)} vs B ${B.unintendedMean.toFixed(2)}.`,
    };
    const caveats = [
        "Intent accuracy is LLM-judged — labeled as such; the mechanical proxy (checksPass && zero unintended changes) is reported alongside so the conclusion never rests on the judge alone.",
        "Clarification answers come from a simulated user (the task oracle), not a real human.",
        "Identical agent, prompts, and tools in both conditions; only the instruction differs.",
    ];
    if (raw.repeats === 1) {
        caveats.unshift("n=1 per cell: this is a PILOT SIGNAL, NOT PROOF. Variance is unmeasured; run --repeats N (N≥5) before drawing conclusions.");
    }
    return { generatedAt: raw.generatedAt, mock: raw.mock, repeats: raw.repeats, perTask, overall: { A, B }, fewers, caveats };
}
function mdTable(a) {
    const lines = [];
    lines.push("| task | cond | checks | unintended | turns | wall s | agent tok | intent tok | asked? | judge acc* | proxy |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    for (const t of a.perTask) {
        for (const cond of ["A", "B"]) {
            const g = t[cond];
            lines.push(`| ${t.taskId} | ${cond} | ${(g.checksPassRate * 100).toFixed(0)}% | ${g.unintendedMean.toFixed(1)} | ` +
                `${g.turnsMean.toFixed(1)} | ${(g.wallTimeMeanMs / 1000).toFixed(1)} | ${g.agentTokensMean.toFixed(0)} | ` +
                `${g.intentTokensMean.toFixed(0)} | ${(g.questionRate * 100).toFixed(0)}% | ` +
                `${g.judgeAccuracyMean === null ? "n/a" : g.judgeAccuracyMean.toFixed(2)} | ${(g.mechanicalProxyRate * 100).toFixed(0)}% |`);
        }
    }
    return lines.join("\n");
}
function renderMarkdown(a) {
    const pilotNote = a.repeats === 1
        ? "> **Pilot signal, not proof.** n=1 per cell; variance is unmeasured. Run with `--repeats N` (N≥5) before concluding anything."
        : `> repeats per cell: ${a.repeats}. Treat differences below sampling noise with care.`;
    return `# Code Director intent-layer experiment — results

Generated: ${a.generatedAt} · mock backend: ${a.mock}

${pilotNote}

## Headline: the four "fewers"

1. **Fewer misunderstandings** — ${a.fewers.misunderstandings}
2. **Fewer unnecessary questions** — ${a.fewers.unnecessaryQuestions}
3. **Fewer tokens** — ${a.fewers.tokens}
4. **Fewer unintended changes** — ${a.fewers.unintendedChanges}

\\* judge acc = mean rubric pass fraction, LLM-judged. proxy = mechanical (checksPass AND zero unintended changes).

## Per-task table

${mdTable(a)}

## Aggregates

| metric | A (raw request) | B (intent layer) |
|---|---|---|
| checks pass rate | ${(a.overall.A.checksPassRate * 100).toFixed(0)}% | ${(a.overall.B.checksPassRate * 100).toFixed(0)}% |
| mean unintended changes | ${a.overall.A.unintendedMean.toFixed(2)} | ${a.overall.B.unintendedMean.toFixed(2)} |
| mean turns | ${a.overall.A.turnsMean.toFixed(1)} | ${a.overall.B.turnsMean.toFixed(1)} |
| mean wall time (s) | ${(a.overall.A.wallTimeMeanMs / 1000).toFixed(1)} | ${(a.overall.B.wallTimeMeanMs / 1000).toFixed(1)} |
| mean agent tokens | ${a.overall.A.agentTokensMean.toFixed(0)} | ${a.overall.B.agentTokensMean.toFixed(0)} |
| mean intent tokens | 0 | ${a.overall.B.intentTokensMean.toFixed(0)} |
| mean total tokens | ${a.overall.A.totalTokensMean.toFixed(0)} | ${a.overall.B.totalTokensMean.toFixed(0)} |
| mechanical proxy rate | ${(a.overall.A.mechanicalProxyRate * 100).toFixed(0)}% | ${(a.overall.B.mechanicalProxyRate * 100).toFixed(0)}% |
| LLM-judged intent accuracy | ${a.overall.A.judgeAccuracyMean === null ? "n/a" : a.overall.A.judgeAccuracyMean.toFixed(2)} | ${a.overall.B.judgeAccuracyMean === null ? "n/a" : a.overall.B.judgeAccuracyMean.toFixed(2)} |

## Caveats

${a.caveats.map((c) => `- ${c}`).join("\n")}
`;
}
async function analyzeFile(rawPath) {
    const raw = JSON.parse(await node_fs_1.promises.readFile(rawPath, "utf8"));
    const a = analyze(raw);
    const outDir = node_path_1.default.dirname(rawPath);
    await node_fs_1.promises.writeFile(node_path_1.default.join(outDir, "results.json"), JSON.stringify(a, null, 2));
    await node_fs_1.promises.writeFile(node_path_1.default.join(outDir, "results.md"), renderMarkdown(a));
    console.log(`wrote ${node_path_1.default.join(outDir, "results.json")} and results.md`);
    return a;
}
const isMain = process.argv[1] && node_path_1.default.resolve(process.argv[1]) === node_path_1.default.resolve(__filename);
if (isMain) {
    const p = process.argv[2] || node_path_1.default.join(__dirname, "..", "..", "results", "results.raw.json");
    analyzeFile(p).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
