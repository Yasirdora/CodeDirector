import assert from "node:assert";
import test from "node:test";
import path from "node:path";
import { BackendConfig, setMockResponses } from "../src/backend";
import { prepareRepo, runAgent } from "../src/agent";
import { loadTasks } from "../src/run";

const MOCK: BackendConfig = { baseUrl: "", apiKey: "", model: "mock", mock: true };

test("mock agent loop: done immediately, empty diff, one turn", async () => {
  setMockResponses([]);
  const fixture = path.resolve(__dirname, "..", "..", "fixtures", "task-list");
  const repo = await prepareRepo(fixture, []);
  const r = await runAgent("change nothing", repo, { cfg: MOCK });
  assert.strictEqual(r.turns, 1);
  assert.strictEqual(r.hitTurnCap, false);
  assert.strictEqual(r.doneSummary, "mock: no-op");
  assert.deepStrictEqual(r.changedFiles, []);
  assert.ok(r.agentTokens.total >= 0);
});

test("prepareRepo applies setup commands and commits them", async () => {
  const fixture = path.resolve(__dirname, "..", "..", "fixtures", "image-preview");
  const bench = path.resolve(__dirname, "..", "..", "benchmark");
  const repo = await prepareRepo(fixture, [`node ${path.join(bench, "setup", "t08-apply-intensity.mjs")}`]);
  const r = await runAgent("noop", repo, { cfg: MOCK });
  assert.deepStrictEqual(r.changedFiles, []); // setup is committed; agent no-op ⇒ clean diff
});

test("benchmark YAMLs load and are well-formed", async () => {
  const tasks = await loadTasks();
  assert.ok(tasks.length >= 8, `expected >= 8 tasks, got ${tasks.length}`);
  for (const t of tasks) {
    assert.ok(t.id && t.fixture && t.messy_request, `task missing core fields: ${JSON.stringify(t.id)}`);
    assert.ok(Array.isArray(t.oracle.must_change) && t.oracle.must_change.length > 0, `${t.id}: must_change`);
    assert.ok(Array.isArray(t.oracle.checks) && t.oracle.checks.length > 0, `${t.id}: checks`);
    assert.ok(Array.isArray(t.oracle.rubric) && t.oracle.rubric.length >= 3 && t.oracle.rubric.length <= 5, `${t.id}: rubric 3-5`);
    assert.ok(typeof t.oracle.question_necessary === "boolean", `${t.id}: question_necessary`);
    assert.ok(typeof t.oracle.question_answer === "string", `${t.id}: question_answer`);
  }
});
