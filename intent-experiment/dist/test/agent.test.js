"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_assert_1 = __importDefault(require("node:assert"));
const node_test_1 = __importDefault(require("node:test"));
const node_path_1 = __importDefault(require("node:path"));
const backend_1 = require("../src/backend");
const agent_1 = require("../src/agent");
const run_1 = require("../src/run");
const MOCK = { baseUrl: "", apiKey: "", model: "mock", mock: true };
(0, node_test_1.default)("mock agent loop: done immediately, empty diff, one turn", async () => {
    (0, backend_1.setMockResponses)([]);
    const fixture = node_path_1.default.resolve(__dirname, "..", "..", "fixtures", "task-list");
    const repo = await (0, agent_1.prepareRepo)(fixture, []);
    const r = await (0, agent_1.runAgent)("change nothing", repo, { cfg: MOCK });
    node_assert_1.default.strictEqual(r.turns, 1);
    node_assert_1.default.strictEqual(r.hitTurnCap, false);
    node_assert_1.default.strictEqual(r.doneSummary, "mock: no-op");
    node_assert_1.default.deepStrictEqual(r.changedFiles, []);
    node_assert_1.default.ok(r.agentTokens.total >= 0);
});
(0, node_test_1.default)("prepareRepo applies setup commands and commits them", async () => {
    const fixture = node_path_1.default.resolve(__dirname, "..", "..", "fixtures", "image-preview");
    const bench = node_path_1.default.resolve(__dirname, "..", "..", "benchmark");
    const repo = await (0, agent_1.prepareRepo)(fixture, [`node ${node_path_1.default.join(bench, "setup", "t08-apply-intensity.mjs")}`]);
    const r = await (0, agent_1.runAgent)("noop", repo, { cfg: MOCK });
    node_assert_1.default.deepStrictEqual(r.changedFiles, []); // setup is committed; agent no-op ⇒ clean diff
});
(0, node_test_1.default)("benchmark YAMLs load and are well-formed", async () => {
    const tasks = await (0, run_1.loadTasks)();
    node_assert_1.default.ok(tasks.length >= 8, `expected >= 8 tasks, got ${tasks.length}`);
    for (const t of tasks) {
        node_assert_1.default.ok(t.id && t.fixture && t.messy_request, `task missing core fields: ${JSON.stringify(t.id)}`);
        node_assert_1.default.ok(Array.isArray(t.oracle.must_change) && t.oracle.must_change.length > 0, `${t.id}: must_change`);
        node_assert_1.default.ok(Array.isArray(t.oracle.checks) && t.oracle.checks.length > 0, `${t.id}: checks`);
        node_assert_1.default.ok(Array.isArray(t.oracle.rubric) && t.oracle.rubric.length >= 3 && t.oracle.rubric.length <= 5, `${t.id}: rubric 3-5`);
        node_assert_1.default.ok(typeof t.oracle.question_necessary === "boolean", `${t.id}: question_necessary`);
        node_assert_1.default.ok(typeof t.oracle.question_answer === "string", `${t.id}: question_answer`);
    }
});
