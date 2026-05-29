"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const node_test_1 = __importDefault(require("node:test"));
const backend_1 = require("../src/backend");
const intent_1 = require("../src/intent");
const intent_2 = require("../src/intent");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const MOCK = { baseUrl: "", apiKey: "", model: "mock", mock: true };
(0, node_test_1.default)("mock backend is deterministic for identical input", async () => {
    (0, backend_1.setMockResponses)([]);
    const msgs = [{ role: "user", content: "hello" }];
    const a = await (0, backend_1.chat)(msgs, {}, MOCK);
    const b = await (0, backend_1.chat)(msgs, {}, MOCK);
    node_assert_1.default.deepStrictEqual(a, b);
    node_assert_1.default.strictEqual(a.text, "mock-response");
});
(0, node_test_1.default)("mock backend: scripted queue is consumed in order", async () => {
    (0, backend_1.setMockResponses)([{ text: "first" }, { text: "second" }]);
    node_assert_1.default.strictEqual((await (0, backend_1.chat)([{ role: "user", content: "x" }], {}, MOCK)).text, "first");
    node_assert_1.default.strictEqual((await (0, backend_1.chat)([{ role: "user", content: "x" }], {}, MOCK)).text, "second");
    node_assert_1.default.strictEqual((await (0, backend_1.chat)([{ role: "user", content: "x" }], {}, MOCK)).text, "mock-response");
});
(0, node_test_1.default)("mock backend: intent prompts yield a schema-valid canned object", async () => {
    (0, backend_1.setMockResponses)([]);
    const res = await (0, backend_1.chat)([{ role: "user", content: "INTENT-OBJECT-SCHEMA please" }], {}, MOCK);
    const parsed = (0, intent_2.extractJson)(res.text);
    node_assert_1.default.deepStrictEqual((0, intent_2.validateIntentObject)(parsed), []);
});
(0, node_test_1.default)("estimateUsage is deterministic and monotonic", () => {
    const u1 = (0, backend_1.estimateUsage)([{ role: "user", content: "abcd" }], "efgh");
    const u2 = (0, backend_1.estimateUsage)([{ role: "user", content: "abcd".repeat(4) }], "efgh");
    node_assert_1.default.deepStrictEqual(u1, (0, backend_1.estimateUsage)([{ role: "user", content: "abcd" }], "efgh"));
    node_assert_1.default.ok(u2.prompt > u1.prompt);
    node_assert_1.default.strictEqual(u1.total, u1.prompt + u1.completion);
});
(0, node_test_1.default)("runIntentLayer offline: canned intent, no question, tokens recorded", async () => {
    (0, backend_1.setMockResponses)([]);
    const dir = await node_fs_1.promises.mkdtemp(node_path_1.default.join((0, node_os_1.tmpdir)(), "intent-ctx-"));
    await node_fs_1.promises.writeFile(node_path_1.default.join(dir, "a.ts"), "export function foo() { return 1; }\n");
    const r = await (0, intent_1.runIntentLayer)("make foo faster", dir, { cfg: MOCK });
    node_assert_1.default.strictEqual(r.questionAsked, false);
    node_assert_1.default.ok(r.directive.length > 0);
    node_assert_1.default.ok(r.intentTokens.total > 0);
    node_assert_1.default.deepStrictEqual(r.intent, (0, backend_1.cannedIntentObject)());
});
(0, node_test_1.default)("runIntentLayer offline: scripted divergent intent triggers exactly one question", async () => {
    const divergent = {
        ...(0, backend_1.cannedIntentObject)(),
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
    (0, backend_1.setMockResponses)([{ text: JSON.stringify(divergent) }, { text: "FINAL DIRECTIVE with answer applied" }]);
    const dir = await node_fs_1.promises.mkdtemp(node_path_1.default.join((0, node_os_1.tmpdir)(), "intent-ctx-"));
    await node_fs_1.promises.writeFile(node_path_1.default.join(dir, "a.ts"), "export const x = 1;\n");
    const r = await (0, intent_1.runIntentLayer)("vague request", dir, { cfg: MOCK, oracleAnswer: "Option B please" });
    node_assert_1.default.strictEqual(r.questionAsked, true);
    node_assert_1.default.strictEqual(r.questionAnswer, "Option B please");
    node_assert_1.default.strictEqual(r.directive, "FINAL DIRECTIVE with answer applied");
    node_assert_1.default.strictEqual(backend_1.setMockResponses.length >= 0, true);
});
