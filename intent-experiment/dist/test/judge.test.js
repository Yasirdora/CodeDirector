"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const node_test_1 = __importDefault(require("node:test"));
const judge_1 = require("../src/judge");
const RUBRIC = ["criterion one", "criterion two"];
(0, node_test_1.default)("parseJudgeOutput: valid scores object", () => {
    const out = (0, judge_1.parseJudgeOutput)('{"scores": {"criterion one": true, "criterion two": false}}', RUBRIC);
    node_assert_1.default.deepStrictEqual(out, { "criterion one": true, "criterion two": false });
});
(0, node_test_1.default)("parseJudgeOutput: accepts fenced JSON and bare top-level object", () => {
    node_assert_1.default.deepStrictEqual((0, judge_1.parseJudgeOutput)('```json\n{"scores": {"criterion one": true, "criterion two": true}}\n```', RUBRIC), { "criterion one": true, "criterion two": true });
    node_assert_1.default.deepStrictEqual((0, judge_1.parseJudgeOutput)('{"criterion one": false, "criterion two": true}', RUBRIC), { "criterion one": false, "criterion two": true });
});
(0, node_test_1.default)("parseJudgeOutput: rejects missing/non-boolean/garbage", () => {
    node_assert_1.default.strictEqual((0, judge_1.parseJudgeOutput)('{"scores": {"criterion one": true}}', RUBRIC), null);
    node_assert_1.default.strictEqual((0, judge_1.parseJudgeOutput)('{"scores": {"criterion one": "yes", "criterion two": true}}', RUBRIC), null);
    node_assert_1.default.strictEqual((0, judge_1.parseJudgeOutput)("I cannot judge this", RUBRIC), null);
});
