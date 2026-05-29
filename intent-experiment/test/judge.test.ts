import assert from "node:assert";
import test from "node:test";
import { parseJudgeOutput } from "../src/judge";

const RUBRIC = ["criterion one", "criterion two"];

test("parseJudgeOutput: valid scores object", () => {
  const out = parseJudgeOutput('{"scores": {"criterion one": true, "criterion two": false}}', RUBRIC);
  assert.deepStrictEqual(out, { "criterion one": true, "criterion two": false });
});

test("parseJudgeOutput: accepts fenced JSON and bare top-level object", () => {
  assert.deepStrictEqual(
    parseJudgeOutput('```json\n{"scores": {"criterion one": true, "criterion two": true}}\n```', RUBRIC),
    { "criterion one": true, "criterion two": true },
  );
  assert.deepStrictEqual(
    parseJudgeOutput('{"criterion one": false, "criterion two": true}', RUBRIC),
    { "criterion one": false, "criterion two": true },
  );
});

test("parseJudgeOutput: rejects missing/non-boolean/garbage", () => {
  assert.strictEqual(parseJudgeOutput('{"scores": {"criterion one": true}}', RUBRIC), null);
  assert.strictEqual(parseJudgeOutput('{"scores": {"criterion one": "yes", "criterion two": true}}', RUBRIC), null);
  assert.strictEqual(parseJudgeOutput("I cannot judge this", RUBRIC), null);
});
