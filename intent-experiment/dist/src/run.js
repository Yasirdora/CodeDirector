"use strict";
/**
 * run.ts — benchmark runner.
 *   node dist/src/run.js --pilot | --full | --task <id> [--repeats N] [--mock]
 * Paired design: for each task, condition A (raw messy request) and
 * condition B (refinedDirective) run back-to-back on fresh temp copies.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.repoRoot = repoRoot;
exports.loadTasks = loadTasks;
exports.runOne = runOne;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const yaml_1 = require("yaml");
const backend_1 = require("./backend");
const agent_1 = require("./agent");
const intent_1 = require("./intent");
const measure_1 = require("./measure");
const judge_1 = require("./judge");
const PILOT_TASKS = ["t01-feel-faster", "t02-fix-it", "t05-dont-change-anything-else", "t07-production-ready"];
function repoRoot() {
    return node_path_1.default.resolve(__dirname, "..", "..");
}
async function loadTasks() {
    const dir = node_path_1.default.join(repoRoot(), "benchmark", "tasks");
    const files = (await node_fs_1.promises.readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
    const tasks = [];
    for (const f of files)
        tasks.push((0, yaml_1.parse)(await node_fs_1.promises.readFile(node_path_1.default.join(dir, f), "utf8")));
    return tasks;
}
function substitute(cmd) {
    return cmd.replaceAll("{BENCH}", node_path_1.default.join(repoRoot(), "benchmark"));
}
async function runOne(task, condition, repeat, cfg) {
    const fixtureDir = node_path_1.default.join(repoRoot(), "fixtures", task.fixture);
    const setup = (task.oracle.setup ?? []).map(substitute);
    const workdir = await (0, agent_1.prepareRepo)(fixtureDir, setup);
    const base = {
        taskId: task.id,
        condition,
        repeat,
        checksPass: false,
        checkResults: [],
        unintendedChanges: [],
        changedFiles: [],
        turns: 0,
        wallTimeMs: 0,
        agentTokens: { ...backend_1.ZERO_USAGE },
        intentTokens: { ...backend_1.ZERO_USAGE },
        judgeTokens: { ...backend_1.ZERO_USAGE },
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
            const il = await (0, intent_1.runIntentLayer)(task.messy_request, workdir, {
                oracleAnswer: task.oracle.question_answer,
                cfg,
            });
            instruction = il.directive;
            base.intentTokens = il.intentTokens;
            base.questionAsked = il.questionAsked;
        }
        const agent = await (0, agent_1.runAgent)(instruction, workdir, { maxTurns: 12, cfg });
        base.turns = agent.turns;
        base.wallTimeMs = agent.wallTimeMs;
        base.agentTokens = agent.agentTokens;
        base.changedFiles = agent.changedFiles;
        base.doneSummary = agent.doneSummary;
        base.checkResults = await (0, measure_1.runChecks)(workdir, task.oracle.checks.map(substitute));
        base.checksPass = (0, measure_1.checksPass)(base.checkResults);
        base.unintendedChanges = (0, measure_1.unintendedChanges)(agent.changedFiles, task.oracle.must_change);
        base.mechanicalProxy = (0, measure_1.mechanicalProxy)(base.checkResults, base.unintendedChanges);
        const judged = await (0, judge_1.judgeDiff)(agent.diff, task.oracle.rubric, { cfg });
        base.judgeTokens = judged.tokens;
        base.judgeJudged = judged.judged;
        base.judgeAccuracy = judged.judged ? judged.accuracy : null;
        // trajectory + diff archived per run
        const outDir = node_path_1.default.join(repoRoot(), "results", "runs");
        await node_fs_1.promises.mkdir(outDir, { recursive: true });
        await node_fs_1.promises.writeFile(node_path_1.default.join(outDir, `${task.id}-${condition}-r${repeat}.json`), JSON.stringify({ record: { ...base, error: null }, diff: agent.diff, trajectory: agent.trajectory }, null, 2));
        return { ...base, error: null };
    }
    catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
}
async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--mock"))
        process.env.MOCK_BACKEND = "1";
    const cfg = (0, backend_1.backendConfigFromEnv)();
    const repeats = Number(args[args.indexOf("--repeats") + 1] || 1) || 1;
    let tasks = await loadTasks();
    if (args.includes("--pilot"))
        tasks = tasks.filter((t) => PILOT_TASKS.includes(t.id));
    else if (args.includes("--full")) { /* all */ }
    const ti = args.indexOf("--task");
    if (ti >= 0)
        tasks = tasks.filter((t) => t.id === args[ti + 1]);
    if (tasks.length === 0) {
        console.error("no tasks selected");
        process.exit(2);
    }
    console.log(`benchmark: ${tasks.length} task(s) × 2 conditions × ${repeats} repeat(s) · mock=${cfg.mock}`);
    const records = [];
    for (const task of tasks) {
        for (let r = 0; r < repeats; r++) {
            for (const condition of ["A", "B"]) {
                const t0 = Date.now();
                const rec = await runOne(task, condition, r, cfg);
                records.push(rec);
                console.log(`${rec.taskId} [${condition}] r${r}: checks=${rec.checksPass} unintended=${rec.unintendedChanges.length} ` +
                    `turns=${rec.turns} agentTok=${rec.agentTokens.total} intentTok=${rec.intentTokens.total} ` +
                    `q=${rec.questionAsked} judge=${rec.judgeAccuracy ?? "n/a"} proxy=${rec.mechanicalProxy} ` +
                    `${((Date.now() - t0) / 1000).toFixed(1)}s${rec.error ? ` ERROR: ${rec.error}` : ""}`);
            }
        }
    }
    const outDir = node_path_1.default.join(repoRoot(), "results");
    await node_fs_1.promises.mkdir(outDir, { recursive: true });
    await node_fs_1.promises.writeFile(node_path_1.default.join(outDir, "results.raw.json"), JSON.stringify({ generatedAt: new Date().toISOString(), mock: cfg.mock, repeats, records }, null, 2));
    console.log(`wrote ${node_path_1.default.join(outDir, "results.raw.json")}`);
    const { analyzeFile } = await Promise.resolve().then(() => __importStar(require("./analyze")));
    await analyzeFile(node_path_1.default.join(outDir, "results.raw.json"));
}
const isMain = process.argv[1] && node_path_1.default.resolve(process.argv[1]) === node_path_1.default.resolve(__filename);
if (isMain) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
