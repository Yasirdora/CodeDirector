/**
 * run.ts — benchmark runner.
 *   node dist/src/run.js --pilot | --full | --task <id> [--repeats N] [--mock]
 * Paired design: for each task, condition A (raw messy request) and
 * condition B (refinedDirective) run back-to-back on fresh temp copies.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { BackendConfig, Usage, ZERO_USAGE, backendConfigFromEnv } from "./backend";
import { prepareRepo, runAgent, AgentRunResult } from "./agent";
import { runIntentLayer } from "./intent";
import { runChecks, checksPass, unintendedChanges, mechanicalProxy, CheckResult } from "./measure";
import { judgeDiff } from "./judge";

export interface TaskOracle {
  setup?: string[];
  must_change: string[];
  must_not_change?: string[];
  checks: string[];
  question_answer?: string;
  question_necessary?: boolean;
  rubric: string[];
}

export interface BenchTask {
  id: string;
  fixture: string;
  messy_request: string;
  oracle: TaskOracle;
}

export interface RunRecord {
  taskId: string;
  condition: "A" | "B";
  repeat: number;
  mock: boolean;
  checksPass: boolean;
  checkResults: CheckResult[];
  unintendedChanges: string[];
  changedFiles: string[];
  turns: number;
  wallTimeMs: number;
  agentTokens: Usage;
  intentTokens: Usage;
  judgeTokens: Usage;
  questionAsked: boolean;
  questionNecessary: boolean | null;
  judgeAccuracy: number | null; // null when judge could not parse (LLM-judged)
  judgeJudged: boolean;
  mechanicalProxy: boolean;
  doneSummary: string | null;
  error: string | null;
}

const PILOT_TASKS = ["t01-feel-faster", "t02-fix-it", "t05-dont-change-anything-else", "t07-production-ready"];

/**
 * Top-level provenance flag: true when ANY record used the mock backend.
 * Computed from the records themselves — never from invocation flags. (An
 * earlier version wrote `cfg.mock`, so a --mock invocation could stamp a
 * fully-live result set as mock; `every()` had the opposite failure, hiding
 * mock records in a mixed set.)
 */
export function mockFlagFor(records: Array<Pick<RunRecord, "mock">>): boolean {
  return records.some((r) => r.mock);
}

export function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

export async function loadTasks(): Promise<BenchTask[]> {
  const dir = path.join(repoRoot(), "benchmark", "tasks");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  const tasks: BenchTask[] = [];
  for (const f of files) tasks.push(parseYaml(await fs.readFile(path.join(dir, f), "utf8")) as BenchTask);
  return tasks;
}

function substitute(cmd: string): string {
  return cmd.replaceAll("{BENCH}", path.join(repoRoot(), "benchmark"));
}

export async function runOne(
  task: BenchTask,
  condition: "A" | "B",
  repeat: number,
  cfg: BackendConfig,
): Promise<RunRecord> {
  const fixtureDir = path.join(repoRoot(), "fixtures", task.fixture);
  const setup = (task.oracle.setup ?? []).map(substitute);
  const workdir = await prepareRepo(fixtureDir, setup);
  const base: Omit<RunRecord, "error"> = {
    taskId: task.id,
    condition,
    repeat,
    mock: cfg.mock,
    checksPass: false,
    checkResults: [],
    unintendedChanges: [],
    changedFiles: [],
    turns: 0,
    wallTimeMs: 0,
    agentTokens: { ...ZERO_USAGE },
    intentTokens: { ...ZERO_USAGE },
    judgeTokens: { ...ZERO_USAGE },
    questionAsked: false,
    questionNecessary: task.oracle.question_necessary ?? null,
    judgeAccuracy: null,
    judgeJudged: false,
    mechanicalProxy: false,
    doneSummary: null,
  };

  try {
    let instruction = task.messy_request;
    if (condition === "B") {
      const il = await runIntentLayer(task.messy_request, workdir, {
        oracleAnswer: task.oracle.question_answer,
        cfg,
      });
      instruction = il.directive;
      base.intentTokens = il.intentTokens;
      base.questionAsked = il.questionAsked;
    }

    const agent: AgentRunResult = await runAgent(instruction, workdir, { maxTurns: 12, cfg });
    base.turns = agent.turns;
    base.wallTimeMs = agent.wallTimeMs;
    base.agentTokens = agent.agentTokens;
    base.changedFiles = agent.changedFiles;
    base.doneSummary = agent.doneSummary;

    base.checkResults = await runChecks(workdir, task.oracle.checks.map(substitute));
    base.checksPass = checksPass(base.checkResults);
    base.unintendedChanges = unintendedChanges(agent.changedFiles, task.oracle.must_change);
    base.mechanicalProxy = mechanicalProxy(base.checkResults, base.unintendedChanges);

    const judged = await judgeDiff(agent.diff, task.oracle.rubric, { cfg });
    base.judgeTokens = judged.tokens;
    base.judgeJudged = judged.judged;
    base.judgeAccuracy = judged.judged ? judged.accuracy : null;

    // trajectory + diff archived per run
    const outDir = path.join(repoRoot(), "results", "runs");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, `${task.id}-${condition}-r${repeat}.json`),
      JSON.stringify({ record: { ...base, error: null }, diff: agent.diff, trajectory: agent.trajectory }, null, 2),
    );
    return { ...base, error: null };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--mock")) process.env.MOCK_BACKEND = "1";
  const cfg = backendConfigFromEnv();
  const repeats = Number(args[args.indexOf("--repeats") + 1] || 1) || 1;

  let tasks = await loadTasks();
  if (args.includes("--pilot")) tasks = tasks.filter((t) => PILOT_TASKS.includes(t.id));
  else if (args.includes("--full")) { /* all */ }
  const ti = args.indexOf("--task");
  if (ti >= 0) tasks = tasks.filter((t) => t.id === args[ti + 1]);
  if (tasks.length === 0) {
    console.error("no tasks selected");
    process.exit(2);
  }

  console.log(`benchmark: ${tasks.length} task(s) × 2 conditions × ${repeats} repeat(s) · mock=${cfg.mock}`);
  const outDir = path.join(repoRoot(), "results");
  await fs.mkdir(outDir, { recursive: true });
  const rawPath = path.join(outDir, "results.raw.json");

  // Incremental persistence: load existing records and upsert after EVERY
  // run, keyed by (taskId, condition, repeat), so a killed invocation never
  // loses completed runs and separate invocations accumulate.
  let existing: RunRecord[] = [];
  try {
    existing = (JSON.parse(await fs.readFile(rawPath, "utf8")) as { records: RunRecord[] }).records ?? [];
  } catch { /* first run */ }
  const byKey = new Map<string, RunRecord>();
  for (const r of existing) byKey.set(`${r.taskId}|${r.condition}|${r.repeat}`, r);

  const persist = async (): Promise<void> => {
    const records = [...byKey.values()].sort(
      (a, b) => a.taskId.localeCompare(b.taskId) || a.condition.localeCompare(b.condition) || a.repeat - b.repeat,
    );
    await fs.writeFile(
      rawPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), mock: mockFlagFor(records), repeats, records }, null, 2),
    );
  };

  for (const task of tasks) {
    for (let r = 0; r < repeats; r++) {
      for (const condition of ["A", "B"] as const) {
        const key = `${task.id}|${condition}|${r}`;
        if (byKey.has(key) && !byKey.get(key)!.error) {
          console.log(`${task.id} [${condition}] r${r}: already recorded, skipping`);
          continue;
        }
        const t0 = Date.now();
        const rec = await runOne(task, condition, r, cfg);
        byKey.set(key, rec);
        await persist();
        console.log(
          `${rec.taskId} [${condition}] r${r}: checks=${rec.checksPass} unintended=${rec.unintendedChanges.length} ` +
            `turns=${rec.turns} agentTok=${rec.agentTokens.total} intentTok=${rec.intentTokens.total} ` +
            `q=${rec.questionAsked} judge=${rec.judgeAccuracy ?? "n/a"} proxy=${rec.mechanicalProxy} ` +
            `${((Date.now() - t0) / 1000).toFixed(1)}s${rec.error ? ` ERROR: ${rec.error}` : ""}`,
        );
      }
    }
  }

  await persist();
  console.log(`wrote ${rawPath} (${byKey.size} records)`);

  const { analyzeFile } = await import("./analyze");
  await analyzeFile(rawPath);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
