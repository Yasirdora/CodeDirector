/**
 * backend.ts — OpenAI-compatible chat backend with tool-calling support
 * and a deterministic scripted mock (MOCK_BACKEND=1) for offline tests.
 *
 * Config via env:
 *   OPENAI_BASE_URL  (default: https://api.openai.com/v1)
 *   OPENAI_API_KEY   (required for live calls)
 *   OPENAI_MODEL     (default: gpt-4o)
 *   MOCK_BACKEND=1 forces the mock regardless of key availability.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema object
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string, as the API returns it
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface Usage {
  prompt: number;
  completion: number;
  total: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export interface ChatOptions {
  tools?: ToolSpec[];
  temperature?: number;
}

export interface BackendConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  mock: boolean;
}

export function backendConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  return {
    baseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: env.OPENAI_API_KEY || "",
    model: env.OPENAI_MODEL || "gpt-4o",
    mock: env.MOCK_BACKEND === "1",
  };
}

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

export type MockResponder =
  | Partial<ChatResult> & { text?: string }
  | ((messages: ChatMessage[], opts: ChatOptions) => ChatResult);

let mockQueue: MockResponder[] = [];

/** Replace the mock script. Test-only; deterministic and offline. */
export function setMockResponses(responders: MockResponder[]): void {
  mockQueue = [...responders];
}

/** Estimate token usage from character counts (≈4 chars/token). Deterministic. */
export function estimateUsage(messages: ChatMessage[], text: string): Usage {
  const inChars = messages.reduce(
    (n, m) => n + (m.content?.length ?? 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0),
    0,
  );
  const prompt = Math.ceil(inChars / 4);
  const completion = Math.ceil(text.length / 4);
  return { prompt, completion, total: prompt + completion };
}

/**
 * Deterministic fallback when the mock queue is empty. Behaves by message
 * shape so the whole harness is exercisable offline with zero scripting:
 *  - a prompt containing the intent marker yields a canned valid Intent Object;
 *  - a tool-loop conversation yields an immediate `done` tool call;
 *  - anything else yields a fixed text reply.
 */
function defaultMockResponse(messages: ChatMessage[], opts: ChatOptions): ChatResult {
  const joined = messages.map((m) => m.content ?? "").join("\n");
  if (joined.includes("INTENT-OBJECT-SCHEMA")) {
    const text = JSON.stringify(cannedIntentObject());
    return { text, toolCalls: [], usage: estimateUsage(messages, text) };
  }
  if (joined.includes("REFINED-DIRECTIVE-RECOMPILE")) {
    const text = "Mock refined directive: apply the requested change exactly; assuming defaults where unspecified.";
    return { text, toolCalls: [], usage: estimateUsage(messages, text) };
  }
  if (opts.tools && opts.tools.length > 0) {
    const last = messages[messages.length - 1];
    // After tool results arrive, finish. Otherwise call `done` immediately.
    void last;
    const call: ToolCall = { id: "mock-call-1", name: "done", arguments: JSON.stringify({ summary: "mock: no-op" }) };
    return { text: "", toolCalls: [call], usage: estimateUsage(messages, "") };
  }
  const text = "mock-response";
  return { text, toolCalls: [], usage: estimateUsage(messages, text) };
}

export function cannedIntentObject(): Record<string, unknown> {
  return {
    goal: "mock goal",
    observedProblem: "mock observed problem",
    keep: ["public API"],
    deny: [],
    desiredOutcome: "mock outcome",
    unknowns: [],
    interpretations: [
      { reading: "reading A", observableDifference: "difference A" },
      { reading: "reading B", observableDifference: "difference B" },
    ],
    divergent: false,
    question: null,
    refinedDirective: "Mock refined directive: do the mock thing; assuming mock assumption.",
  };
}

function runMock(messages: ChatMessage[], opts: ChatOptions): ChatResult {
  const next = mockQueue.shift();
  if (next === undefined) return defaultMockResponse(messages, opts);
  if (typeof next === "function") return next(messages, opts);
  const text = next.text ?? "";
  return {
    text,
    toolCalls: next.toolCalls ?? [],
    usage: next.usage ?? estimateUsage(messages, text),
  };
}

// ---------------------------------------------------------------------------
// Live backend (plain fetch, no SDK)
// ---------------------------------------------------------------------------

function toApiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    return out;
  });
}

function toApiTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function liveChat(
  messages: ChatMessage[],
  opts: ChatOptions,
  cfg: BackendConfig,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: toApiMessages(messages),
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = toApiTools(opts.tools);
    body.tool_choice = "auto";
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120_000);
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`backend HTTP ${res.status}: ${errText.slice(0, 500)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const msg = data.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc, i) => ({
        id: tc.id ?? `call_${i}`,
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "{}",
      }));
      const text = msg.content ?? "";
      const usage: Usage = data.usage
        ? {
            prompt: data.usage.prompt_tokens ?? 0,
            completion: data.usage.completion_tokens ?? 0,
            total: data.usage.total_tokens ?? 0,
          }
        : estimateUsage(messages, text);
      return { text, toolCalls, usage };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
  cfg: BackendConfig = backendConfigFromEnv(),
): Promise<ChatResult> {
  if (cfg.mock) return runMock(messages, opts);
  if (!cfg.apiKey) throw new Error("OPENAI_API_KEY not set and MOCK_BACKEND != 1");
  return liveChat(messages, opts, cfg);
}

export function sumUsage(a: Usage, b: Usage): Usage {
  return { prompt: a.prompt + b.prompt, completion: a.completion + b.completion, total: a.total + b.total };
}

export const ZERO_USAGE: Usage = { prompt: 0, completion: 0, total: 0 };
