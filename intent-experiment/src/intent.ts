/**
 * intent.ts — the intent layer under test.
 *
 * Pipeline for one messy request + target repo:
 *   1. build a small repo context (cdir index/map top ~15 symbols + file tree)
 *   2. model call → strict-schema Intent Object
 *   3. ambiguity gate: if divergent → emit ONE question; the harness answers
 *      it from the task oracle and the directive is recompiled with the answer.
 *      If not divergent, the assumption must be stated inside refinedDirective.
 *   4. record intentTokens + questionAsked.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  BackendConfig,
  ChatMessage,
  Usage,
  ZERO_USAGE,
  backendConfigFromEnv,
  chat,
  sumUsage,
} from "./backend";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Intent Object schema
// ---------------------------------------------------------------------------

export interface IntentInterpretation {
  reading: string;
  observableDifference: string;
}

export interface IntentQuestionOption {
  id: string;
  label: string;
}

export interface IntentQuestion {
  text: string;
  options: IntentQuestionOption[]; // 2-4 concrete options
  recommended: string; // id of recommended option
}

export interface IntentObject {
  goal: string;
  observedProblem: string;
  keep: string[];
  deny: string[];
  desiredOutcome: string;
  unknowns: string[];
  interpretations: IntentInterpretation[]; // >= 2
  divergent: boolean;
  question: IntentQuestion | null;
  refinedDirective: string;
}

/** Strict structural validation. Returns a list of human-readable errors. */
export function validateIntentObject(x: unknown): string[] {
  const errs: string[] = [];
  if (typeof x !== "object" || x === null || Array.isArray(x)) return ["not an object"];
  const o = x as Record<string, unknown>;

  for (const f of ["goal", "observedProblem", "desiredOutcome", "refinedDirective"]) {
    if (typeof o[f] !== "string" || (o[f] as string).trim() === "") errs.push(`${f}: must be a non-empty string`);
  }
  for (const f of ["keep", "deny", "unknowns"]) {
    if (!Array.isArray(o[f]) || !(o[f] as unknown[]).every((s) => typeof s === "string"))
      errs.push(`${f}: must be a string array`);
  }
  if (typeof o.divergent !== "boolean") errs.push("divergent: must be a boolean");

  if (!Array.isArray(o.interpretations) || o.interpretations.length < 2) {
    errs.push("interpretations: must be an array with at least 2 entries");
  } else {
    for (const [i, it] of (o.interpretations as unknown[]).entries()) {
      const r = it as Record<string, unknown>;
      if (typeof r?.reading !== "string" || typeof r?.observableDifference !== "string")
        errs.push(`interpretations[${i}]: needs reading + observableDifference strings`);
    }
  }

  if (o.divergent === true) {
    const q = o.question as Record<string, unknown> | null;
    if (typeof q !== "object" || q === null) {
      errs.push("question: required when divergent is true");
    } else {
      if (typeof q.text !== "string" || q.text.trim() === "") errs.push("question.text: required");
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
        errs.push("question.options: must have 2-4 options");
      } else {
        for (const [i, opt] of (q.options as unknown[]).entries()) {
          const oo = opt as Record<string, unknown>;
          if (typeof oo?.id !== "string" || typeof oo?.label !== "string")
            errs.push(`question.options[${i}]: needs id + label`);
        }
        const ids = (q.options as IntentQuestionOption[]).map((oo) => oo.id);
        if (typeof q.recommended !== "string" || !ids.includes(q.recommended))
          errs.push("question.recommended: must be one of the option ids");
      }
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// JSON extraction from model text
// ---------------------------------------------------------------------------

/** Extract the first balanced top-level JSON object from arbitrary text. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start < 0) throw new Error("no JSON object found in model output");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error("unbalanced JSON in model output");
}

// ---------------------------------------------------------------------------
// Repo context (small on purpose — this is part of the token story)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".codedirector", "results"]);

async function fileTree(root: string, maxEntries = 60): Promise<string> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= maxEntries) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxEntries) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        out.push(`${rel}${e.name}/`);
        await walk(path.join(dir, e.name), `${rel}${e.name}/`);
      } else {
        out.push(rel + e.name);
      }
    }
  }
  await walk(root, "");
  return out.join("\n");
}

function cdirCliPath(): string {
  return (
    process.env.CDIR_CLI ||
    path.resolve(__dirname, "..", "..", "..", "codedirector", "dist", "src", "cli.js")
  );
}

/**
 * Build a compact repo context: file tree + cdir ranked map (top ~15 symbols,
 * token-budgeted). Falls back to tree-only if cdir is unavailable.
 */
export async function buildRepoContext(repoRoot: string, query: string): Promise<string> {
  const tree = await fileTree(repoRoot).catch(() => "(tree unavailable)");
  let repoMap = "(repo map unavailable)";
  try {
    await execFileP(process.execPath, [cdirCliPath(), "index", "--root", repoRoot], {
      timeout: 60_000,
    });
    const { stdout } = await execFileP(
      process.execPath,
      [cdirCliPath(), "map", query.slice(0, 200), "--root", repoRoot, "--top", "15", "--max-tokens", "900"],
      { timeout: 60_000 },
    );
    repoMap = stdout.trim() || "(empty map)";
  } catch {
    // fallback: naive symbol skim
    try {
      const lines: string[] = [];
      for (const rel of tree.split("\n").filter((l) => l.endsWith(".ts"))) {
        const src = await fs.readFile(path.join(repoRoot, rel), "utf8");
        for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|interface|const)\s+([A-Za-z0-9_]+)/g)) {
          lines.push(`${rel}: ${m[1]}`);
          if (lines.length >= 15) break;
        }
        if (lines.length >= 15) break;
      }
      repoMap = lines.join("\n") || "(no symbols found)";
    } catch {
      /* keep placeholder */
    }
  }
  return `FILE TREE:\n${tree}\n\nREPO MAP (top symbols for the request):\n${repoMap}`;
}

// ---------------------------------------------------------------------------
// Intent extraction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an intent compiler for coding agents. A human gives a messy request for a software repository. Your job: turn it into a precise Intent Object so a coding agent can act with fewer misunderstandings.

You MUST reply with a single JSON object matching INTENT-OBJECT-SCHEMA exactly:
{
  "goal": "one sentence: what the human wants true",
  "observedProblem": "what in the repo/request motivates this",
  "keep": ["things that must NOT change (APIs, files, behaviors)"],
  "deny": ["repo paths the agent must not touch"],
  "desiredOutcome": "how the human will know it worked",
  "unknowns": ["things you genuinely cannot tell from the request"],
  "interpretations": [
    {"reading": "candidate reading 1", "observableDifference": "how the user would observably tell this reading apart"},
    {"reading": "candidate reading 2", "observableDifference": "..."}
  ],
  "divergent": true|false,   // true ONLY if the interpretations differ in user-observable behavior
  "question": null | {"text": "ONE question", "options": [{"id":"a","label":"..."},{"id":"b","label":"..."}], "recommended": "a"},
  "refinedDirective": "the final precise instruction for the coding agent: goal + boundaries (keep/deny) + expected verification. If not divergent, state the assumption you made inline as 'assuming X'."
}

Rules:
- At least 2 interpretations, always. divergent=true only when they lead to observably different software.
- If divergent, ask exactly ONE question with 2-4 concrete options and a recommendation; set refinedDirective to your best guess marked 'PROVISIONAL'.
- If not divergent, question must be null and refinedDirective must contain 'assuming ...'.
- Output JSON only. No prose.`;

export interface IntentLayerResult {
  intent: IntentObject;
  directive: string; // final directive handed to the agent
  questionAsked: boolean;
  question: IntentQuestion | null;
  questionAnswer: string | null; // oracle answer, when asked
  intentTokens: Usage;
  repoContextChars: number;
}

export interface IntentLayerOptions {
  /** Simulated user's answer to the clarification question (from task oracle). */
  oracleAnswer?: string;
  cfg?: BackendConfig;
}

export async function runIntentLayer(
  messyRequest: string,
  repoRoot: string,
  opts: IntentLayerOptions = {},
): Promise<IntentLayerResult> {
  const cfg = opts.cfg ?? backendConfigFromEnv();
  let intentTokens = { ...ZERO_USAGE };

  const context = await buildRepoContext(repoRoot, messyRequest);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `MESSY REQUEST:\n${messyRequest}\n\n${context}`,
    },
  ];

  const res = await chat(messages, {}, cfg);
  intentTokens = sumUsage(intentTokens, res.usage);
  const parsed = extractJson(res.text);
  const errs = validateIntentObject(parsed);
  if (errs.length > 0) throw new Error(`intent object failed schema: ${errs.join("; ")}`);
  const intent = parsed as unknown as IntentObject;

  let directive = intent.refinedDirective;
  let questionAnswer: string | null = null;

  if (intent.divergent && intent.question) {
    questionAnswer = opts.oracleAnswer ?? "(no answer available — use the recommended option)";
    const rec = intent.question.options.find((o) => o.id === intent.question!.recommended);
    const recompile: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: res.text },
      {
        role: "user",
        content: `REFINED-DIRECTIVE-RECOMPILE\nYou asked: "${intent.question.text}"\nThe user answered: "${questionAnswer}"\n(Your recommended option was: ${rec ? `${rec.id}) ${rec.label}` : intent.question.recommended})\nRewrite the final refinedDirective only — precise instruction for the coding agent: goal + boundaries + expected verification. Reply with the directive text only, no JSON.`,
      },
    ];
    const res2 = await chat(recompile, {}, cfg);
    intentTokens = sumUsage(intentTokens, res2.usage);
    directive = res2.text.trim() || intent.refinedDirective;
  }

  return {
    intent,
    directive,
    questionAsked: Boolean(intent.divergent && intent.question),
    question: intent.divergent ? intent.question : null,
    questionAnswer,
    intentTokens,
    repoContextChars: context.length,
  };
}
