"use strict";
/**
 * Mock-provenance tests (field-reported defect): the top-level `mock` flag
 * must be data provenance — "any record mocked" — never an invocation flag,
 * and mixed sets must be labeled mixed.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const run_1 = require("../src/run");
const analyze_1 = require("../src/analyze");
function rec(mock) {
    return {
        taskId: "t01",
        condition: "A",
        repeat: 0,
        mock,
        checksPass: true,
        checkResults: [],
        unintendedChanges: [],
        changedFiles: [],
        turns: 1,
        wallTimeMs: 1,
        agentTokens: { prompt: 0, completion: 0, total: 0 },
        intentTokens: { prompt: 0, completion: 0, total: 0 },
        judgeTokens: { prompt: 0, completion: 0, total: 0 },
        questionAsked: false,
        questionNecessary: null,
        judgeAccuracy: null,
        judgeJudged: false,
        mechanicalProxy: true,
        doneSummary: null,
        error: null,
    };
}
(0, node_test_1.default)("mockFlagFor: provenance is any-record-mocked, not invocation state", () => {
    strict_1.default.equal((0, run_1.mockFlagFor)([]), false);
    strict_1.default.equal((0, run_1.mockFlagFor)([rec(false), rec(false)]), false, "fully live set → false");
    strict_1.default.equal((0, run_1.mockFlagFor)([rec(false), rec(true)]), true, "one mock record → true (mixed sets cannot hide)");
    strict_1.default.equal((0, run_1.mockFlagFor)([rec(true), rec(true)]), true);
});
(0, node_test_1.default)("analyze: provenance computed from records, mixed sets labeled", () => {
    const live = { generatedAt: "2026-01-01T00:00:00.000Z", mock: true, repeats: 1, records: [rec(false), rec(false)] };
    const a1 = (0, analyze_1.analyze)(live);
    strict_1.default.equal(a1.mock, false, "stale top-level mock:true cannot mislabel live records");
    strict_1.default.equal(a1.mockRecords, 0);
    const mixed = { generatedAt: "2026-01-01T00:00:00.000Z", mock: false, repeats: 1, records: [rec(false), rec(true)] };
    const a2 = (0, analyze_1.analyze)(mixed);
    strict_1.default.equal(a2.mock, true, "any mock record → true even when top-level said false");
    strict_1.default.equal(a2.mockRecords, 1);
    strict_1.default.ok(a2.caveats.some((c) => c.includes("MIXED PROVENANCE")), "mixed set carries an explicit caveat");
    strict_1.default.ok((0, analyze_1.renderMarkdown)(a2).includes("MIXED — 1 of 2 records"), "markdown header shows the mix");
});
