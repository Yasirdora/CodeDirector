"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const node_test_1 = __importDefault(require("node:test"));
const backend_1 = require("../src/backend");
const intent_1 = require("../src/intent");
(0, node_test_1.default)("schema: canned intent object is valid", () => {
    node_assert_1.default.deepStrictEqual((0, intent_1.validateIntentObject)((0, backend_1.cannedIntentObject)()), []);
});
(0, node_test_1.default)("schema: rejects missing fields", () => {
    node_assert_1.default.ok((0, intent_1.validateIntentObject)(null).length > 0);
    node_assert_1.default.ok((0, intent_1.validateIntentObject)({}).some((e) => e.startsWith("goal")));
    const bad = { ...(0, backend_1.cannedIntentObject)(), keep: "not-an-array" };
    node_assert_1.default.ok((0, intent_1.validateIntentObject)(bad).some((e) => e.startsWith("keep")));
});
(0, node_test_1.default)("schema: requires >= 2 interpretations", () => {
    const o = { ...(0, backend_1.cannedIntentObject)(), interpretations: [{ reading: "a", observableDifference: "b" }] };
    node_assert_1.default.ok((0, intent_1.validateIntentObject)(o).some((e) => e.includes("interpretations")));
});
(0, node_test_1.default)("schema: divergent requires a well-formed question", () => {
    const base = (0, backend_1.cannedIntentObject)();
    node_assert_1.default.ok((0, intent_1.validateIntentObject)({ ...base, divergent: true, question: null }).some((e) => e.includes("question")));
    const oneOption = {
        ...base,
        divergent: true,
        question: { text: "q?", options: [{ id: "a", label: "A" }], recommended: "a" },
    };
    node_assert_1.default.ok((0, intent_1.validateIntentObject)(oneOption).some((e) => e.includes("2-4")));
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
    node_assert_1.default.ok((0, intent_1.validateIntentObject)(badRec).some((e) => e.includes("recommended")));
});
(0, node_test_1.default)("extractJson: handles fenced, bare, and prose-wrapped JSON", () => {
    node_assert_1.default.deepStrictEqual((0, intent_1.extractJson)('```json\n{"a":1}\n```'), { a: 1 });
    node_assert_1.default.deepStrictEqual((0, intent_1.extractJson)('{"a":2}'), { a: 2 });
    node_assert_1.default.deepStrictEqual((0, intent_1.extractJson)('here you go: {"a":"} tricky {}"} done'), { a: "} tricky {}" });
    node_assert_1.default.throws(() => (0, intent_1.extractJson)("no json here"));
    node_assert_1.default.throws(() => (0, intent_1.extractJson)('{"a": 1'));
});
