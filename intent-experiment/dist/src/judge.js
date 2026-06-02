"use strict";
/**
 * judge.ts — LLM judge scoring the final repo diff against the task rubric.
 * ALWAYS labeled as LLM-judged; the mechanical proxy lives in measure.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseJudgeOutput = parseJudgeOutput;
exports.judgeDiff = judgeDiff;
const backend_1 = require("./backend");
const intent_1 = require("./intent");
/** Parse judge output: {"scores": {"criterion": true|false, ...}}. Exported for tests. */
function parseJudgeOutput(text, rubric) {
    let parsed;
    try {
        parsed = (0, intent_1.extractJson)(text);
    }
    catch {
        return null;
    }
    const o = parsed;
    const scores = (o?.scores ?? o);
    if (typeof scores !== "object" || scores === null)
        return null;
    const out = {};
    for (const criterion of rubric) {
        const v = scores[criterion];
        if (typeof v !== "boolean")
            return null;
        out[criterion] = v;
    }
    return out;
}
async function judgeDiff(diff, rubric, opts = {}) {
    const cfg = opts.cfg ?? (0, backend_1.backendConfigFromEnv)();
    const criteriaList = rubric.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const keysExample = rubric.map((c) => JSON.stringify(c)).join(", ");
    const res = await (0, backend_1.chat)([
        {
            role: "system",
            content: "You are a strict code-review judge. Given a git diff and binary rubric criteria, decide true/false for each criterion based ONLY on the diff. Reply with JSON only: {\"scores\": {<criterion>: true|false, ...}} using the criterion strings exactly as given.",
        },
        {
            role: "user",
            content: `RUBRIC CRITERIA:\n${criteriaList}\n\nReply with a JSON object "scores" containing exactly these keys: ${keysExample}\n\nGIT DIFF:\n${diff.slice(0, 30_000) || "(empty diff)"}`,
        },
    ], {}, cfg);
    const scores = parseJudgeOutput(res.text, rubric);
    if (!scores) {
        return { scores: {}, accuracy: 0, judged: false, raw: res.text, tokens: res.usage ?? { ...backend_1.ZERO_USAGE } };
    }
    const trues = Object.values(scores).filter(Boolean).length;
    return {
        scores,
        accuracy: rubric.length ? trues / rubric.length : 0,
        judged: true,
        raw: res.text,
        tokens: res.usage,
    };
}
