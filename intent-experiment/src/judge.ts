/**
 * judge.ts — LLM judge scoring the final repo diff against the task rubric.
 * ALWAYS labeled as LLM-judged; the mechanical proxy lives in measure.ts.
 */

import {
  BackendConfig,
  Usage,
  ZERO_USAGE,
  backendConfigFromEnv,
  chat,
} from "./backend";
import { extractJson } from "./intent";

export interface JudgeResult {
  scores: Record<string, boolean>;
  accuracy: number; // fraction of rubric criteria scored true (0-1)
  judged: boolean; // false when the judge could not run/parse
  raw: string;
  tokens: Usage;
}

/** Parse judge output: {"scores": {"criterion": true|false, ...}}. Exported for tests. */
export function parseJudgeOutput(text: string, rubric: string[]): Record<string, boolean> | null {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const scores = (o?.scores ?? o) as Record<string, unknown>;
  if (typeof scores !== "object" || scores === null) return null;
  const out: Record<string, boolean> = {};
  for (const criterion of rubric) {
    const v = scores[criterion];
    if (typeof v !== "boolean") return null;
    out[criterion] = v;
  }
  return out;
}

export async function judgeDiff(
  diff: string,
  rubric: string[],
  opts: { cfg?: BackendConfig } = {},
): Promise<JudgeResult> {
  const cfg = opts.cfg ?? backendConfigFromEnv();
  const criteriaList = rubric.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const keysExample = rubric.map((c) => JSON.stringify(c)).join(", ");
  const res = await chat(
    [
      {
        role: "system",
        content:
          "You are a strict code-review judge. Given a git diff and binary rubric criteria, decide true/false for each criterion based ONLY on the diff. Reply with JSON only: {\"scores\": {<criterion>: true|false, ...}} using the criterion strings exactly as given.",
      },
      {
        role: "user",
        content: `RUBRIC CRITERIA:\n${criteriaList}\n\nReply with a JSON object "scores" containing exactly these keys: ${keysExample}\n\nGIT DIFF:\n${diff.slice(0, 30_000) || "(empty diff)"}`,
      },
    ],
    { temperature: 0 },
    cfg,
  );
  const scores = parseJudgeOutput(res.text, rubric);
  if (!scores) {
    return { scores: {}, accuracy: 0, judged: false, raw: res.text, tokens: res.usage ?? { ...ZERO_USAGE } };
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
