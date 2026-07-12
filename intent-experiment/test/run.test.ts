/**
 * Mock-provenance tests (field-reported defect): the top-level `mock` flag
 * must be data provenance — "any record mocked" — never an invocation flag,
 * and mixed sets must be labeled mixed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mockFlagFor, RunRecord } from "../src/run";
import { analyze, renderMarkdown } from "../src/analyze";

function rec(mock: boolean): RunRecord {
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

test("mockFlagFor: provenance is any-record-mocked, not invocation state", () => {
  assert.equal(mockFlagFor([]), false);
  assert.equal(mockFlagFor([rec(false), rec(false)]), false, "fully live set → false");
  assert.equal(mockFlagFor([rec(false), rec(true)]), true, "one mock record → true (mixed sets cannot hide)");
  assert.equal(mockFlagFor([rec(true), rec(true)]), true);
});

test("analyze: provenance computed from records, mixed sets labeled", () => {
  const live = { generatedAt: "2026-01-01T00:00:00.000Z", mock: true, repeats: 1, records: [rec(false), rec(false)] };
  const a1 = analyze(live);
  assert.equal(a1.mock, false, "stale top-level mock:true cannot mislabel live records");
  assert.equal(a1.mockRecords, 0);

  const mixed = { generatedAt: "2026-01-01T00:00:00.000Z", mock: false, repeats: 1, records: [rec(false), rec(true)] };
  const a2 = analyze(mixed);
  assert.equal(a2.mock, true, "any mock record → true even when top-level said false");
  assert.equal(a2.mockRecords, 1);
  assert.ok(a2.caveats.some((c) => c.includes("MIXED PROVENANCE")), "mixed set carries an explicit caveat");
  assert.ok(renderMarkdown(a2).includes("MIXED — 1 of 2 records"), "markdown header shows the mix");
});
