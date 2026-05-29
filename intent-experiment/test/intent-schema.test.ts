import assert from "node:assert";
import test from "node:test";
import { cannedIntentObject } from "../src/backend";
import { extractJson, validateIntentObject } from "../src/intent";

test("schema: canned intent object is valid", () => {
  assert.deepStrictEqual(validateIntentObject(cannedIntentObject()), []);
});

test("schema: rejects missing fields", () => {
  assert.ok(validateIntentObject(null).length > 0);
  assert.ok(validateIntentObject({}).some((e) => e.startsWith("goal")));
  const bad = { ...cannedIntentObject(), keep: "not-an-array" } as Record<string, unknown>;
  assert.ok(validateIntentObject(bad).some((e) => e.startsWith("keep")));
});

test("schema: requires >= 2 interpretations", () => {
  const o = { ...(cannedIntentObject() as Record<string, unknown>), interpretations: [{ reading: "a", observableDifference: "b" }] };
  assert.ok(validateIntentObject(o).some((e) => e.includes("interpretations")));
});

test("schema: divergent requires a well-formed question", () => {
  const base = cannedIntentObject() as Record<string, unknown>;
  assert.ok(validateIntentObject({ ...base, divergent: true, question: null }).some((e) => e.includes("question")));
  const oneOption = {
    ...base,
    divergent: true,
    question: { text: "q?", options: [{ id: "a", label: "A" }], recommended: "a" },
  };
  assert.ok(validateIntentObject(oneOption).some((e) => e.includes("2-4")));
  const badRec = {
    ...base,
    divergent: true,
    question: {
      text: "q?",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      recommended: "zzz",
    },
  };
  assert.ok(validateIntentObject(badRec).some((e) => e.includes("recommended")));
});

test("extractJson: handles fenced, bare, and prose-wrapped JSON", () => {
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('{"a":2}'), { a: 2 });
  assert.deepStrictEqual(extractJson('here you go: {"a":"} tricky {}"} done'), { a: "} tricky {}" });
  assert.throws(() => extractJson("no json here"));
  assert.throws(() => extractJson('{"a": 1'));
});
