import assert from "node:assert";
import test from "node:test";
import {
  BackendConfig,
  chat,
  cannedIntentObject,
  setMockResponses,
  estimateUsage,
} from "../src/backend";
import { runIntentLayer } from "../src/intent";
import { validateIntentObject, extractJson } from "../src/intent";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MOCK: BackendConfig = { baseUrl: "", apiKey: "", model: "mock", mock: true };

test("mock backend is deterministic for identical input", async () => {
  setMockResponses([]);
  const msgs = [{ role: "user" as const, content: "hello" }];
  const a = await chat(msgs, {}, MOCK);
  const b = await chat(msgs, {}, MOCK);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.text, "mock-response");
});

test("mock backend: scripted queue is consumed in order", async () => {
  setMockResponses([{ text: "first" }, { text: "second" }]);
  assert.strictEqual((await chat([{ role: "user", content: "x" }], {}, MOCK)).text, "first");
  assert.strictEqual((await chat([{ role: "user", content: "x" }], {}, MOCK)).text, "second");
  assert.strictEqual((await chat([{ role: "user", content: "x" }], {}, MOCK)).text, "mock-response");
});

test("mock backend: intent prompts yield a schema-valid canned object", async () => {
  setMockResponses([]);
  const res = await chat([{ role: "user", content: "INTENT-OBJECT-SCHEMA please" }], {}, MOCK);
  const parsed = extractJson(res.text);
  assert.deepStrictEqual(validateIntentObject(parsed), []);
});

test("estimateUsage is deterministic and monotonic", () => {
  const u1 = estimateUsage([{ role: "user", content: "abcd" }], "efgh");
  const u2 = estimateUsage([{ role: "user", content: "abcd".repeat(4) }], "efgh");
  assert.deepStrictEqual(u1, estimateUsage([{ role: "user", content: "abcd" }], "efgh"));
  assert.ok(u2.prompt > u1.prompt);
  assert.strictEqual(u1.total, u1.prompt + u1.completion);
});

test("runIntentLayer offline: canned intent, no question, tokens recorded", async () => {
  setMockResponses([]);
  const dir = await fs.mkdtemp(path.join(tmpdir(), "intent-ctx-"));
  await fs.writeFile(path.join(dir, "a.ts"), "export function foo() { return 1; }\n");
  const r = await runIntentLayer("make foo faster", dir, { cfg: MOCK });
  assert.strictEqual(r.questionAsked, false);
  assert.ok(r.directive.length > 0);
  assert.ok(r.intentTokens.total > 0);
  assert.deepStrictEqual(r.intent, cannedIntentObject());
});

test("runIntentLayer offline: scripted divergent intent triggers exactly one question", async () => {
  const divergent = {
    ...cannedIntentObject(),
    divergent: true,
    question: {
      text: "Which behavior?",
      options: [
        { id: "a", label: "Option A" },
        { id: "b", label: "Option B" },
      ],
      recommended: "a",
    },
  };
  setMockResponses([{ text: JSON.stringify(divergent) }, { text: "FINAL DIRECTIVE with answer applied" }]);
  const dir = await fs.mkdtemp(path.join(tmpdir(), "intent-ctx-"));
  await fs.writeFile(path.join(dir, "a.ts"), "export const x = 1;\n");
  const r = await runIntentLayer("vague request", dir, { cfg: MOCK, oracleAnswer: "Option B please" });
  assert.strictEqual(r.questionAsked, true);
  assert.strictEqual(r.questionAnswer, "Option B please");
  assert.strictEqual(r.directive, "FINAL DIRECTIVE with answer applied");
  assert.strictEqual(setMockResponses.length >= 0, true);
});
