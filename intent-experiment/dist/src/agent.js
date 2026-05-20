"use strict";
/**
 * agent.ts — minimal tool-loop coding agent.
 * The SAME agent, prompts and tools are used for both benchmark conditions;
 * only the instruction differs (raw messy request vs refinedDirective).
 * Operates in a temp copy of the fixture repo; git-diff after done/turn cap.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_TOOLS = void 0;
exports.runAgent = runAgent;
exports.gitDiff = gitDiff;
exports.prepareRepo = prepareRepo;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_util_1 = require("node:util");
const backend_1 = require("./backend");
const execP = (0, node_util_1.promisify)(node_child_process_1.exec);
exports.AGENT_TOOLS = [
    {
        name: "read_file",
        description: "Read a file from the repository. Returns the file content (truncated to 20000 chars).",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "repo-relative path" } },
            required: ["path"],
        },
    },
    {
        name: "write_file",
        description: "Write a file in the repository (creates parent dirs, overwrites existing).",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "repo-relative path" },
                content: { type: "string" },
            },
            required: ["path", "content"],
        },
    },
    {
        name: "list_files",
        description: "List repository files (optionally under a subdirectory).",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "repo-relative directory, default root" } },
        },
    },
    {
        name: "run_command",
        description: "Run a shell command in the repository root (60s timeout). Returns stdout+stderr and exit code.",
        parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
        },
    },
    {
        name: "done",
        description: "Declare the task finished. Provide a one-line summary of what changed.",
        parameters: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
        },
    },
];
const AGENT_SYSTEM = `You are a coding agent working in a repository. You have tools: read_file, write_file, list_files, run_command, done.

Rules:
- Make the change the instruction asks for. Nothing more.
- Verify your change by running the repo's tests/build before calling done.
- Do not refactor, reformat, or "improve" code outside the instruction's scope.
- Use run_command with e.g. \`node --test test/*.test.ts\` to run tests when present.
- Call done exactly once when finished. Max 12 turns total.`;
function safeResolve(root, rel) {
    const p = node_path_1.default.resolve(root, rel);
    if (p !== root && !p.startsWith(root + node_path_1.default.sep))
        throw new Error(`path escapes repo: ${rel}`);
    return p;
}
async function execTool(root, name, argsJson) {
    let args;
    try {
        args = JSON.parse(argsJson || "{}");
    }
    catch {
        return `ERROR: invalid JSON arguments: ${argsJson.slice(0, 200)}`;
    }
    try {
        switch (name) {
            case "read_file": {
                const content = await node_fs_1.promises.readFile(safeResolve(root, String(args.path ?? "")), "utf8");
                return content.length > 20_000 ? content.slice(0, 20_000) + "\n...[truncated]" : content;
            }
            case "write_file": {
                const p = safeResolve(root, String(args.path ?? ""));
                await node_fs_1.promises.mkdir(node_path_1.default.dirname(p), { recursive: true });
                await node_fs_1.promises.writeFile(p, String(args.content ?? ""), "utf8");
                return `wrote ${args.path} (${String(args.content ?? "").length} chars)`;
            }
            case "list_files": {
                const base = safeResolve(root, String(args.path ?? "."));
                const out = [];
                async function walk(dir, rel) {
                    if (out.length >= 200)
                        return;
                    for (const e of (await node_fs_1.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
                        if (out.length >= 200)
                            return;
                        if (e.isDirectory()) {
                            if ([".git", "node_modules", "dist", ".codedirector"].includes(e.name))
                                continue;
                            await walk(node_path_1.default.join(dir, e.name), `${rel}${e.name}/`);
                        }
                        else {
                            out.push(rel + e.name);
                        }
                    }
                }
                await walk(base, "");
                return out.join("\n") || "(empty)";
            }
            case "run_command": {
                try {
                    const { stdout, stderr } = await execP(String(args.command ?? ""), {
                        cwd: root,
                        timeout: 60_000,
                        maxBuffer: 1024 * 1024,
                        env: { ...process.env, CI: "1" },
                    });
                    return `exit 0\n${stdout}${stderr}`.slice(0, 12_000);
                }
                catch (err) {
                    const e = err;
                    return `exit ${e.code ?? "?"}\n${e.stdout ?? ""}${e.stderr ?? ""}${e.code === undefined ? e.message ?? "" : ""}`.slice(0, 12_000);
                }
            }
            default:
                return `ERROR: unknown tool ${name}`;
        }
    }
    catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`.slice(0, 2000);
    }
}
async function runAgent(instruction, workdir, opts = {}) {
    const cfg = opts.cfg ?? (0, backend_1.backendConfigFromEnv)();
    const maxTurns = opts.maxTurns ?? 12;
    const started = Date.now();
    let agentTokens = { ...backend_1.ZERO_USAGE };
    let doneSummary = null;
    const messages = [
        { role: "system", content: AGENT_SYSTEM },
        { role: "user", content: `INSTRUCTION:\n${instruction}` },
    ];
    let turns = 0;
    while (turns < maxTurns && doneSummary === null) {
        turns++;
        const res = await (0, backend_1.chat)(messages, { tools: exports.AGENT_TOOLS, temperature: 0.2 }, cfg);
        agentTokens = (0, backend_1.sumUsage)(agentTokens, res.usage);
        messages.push({
            role: "assistant",
            content: res.text || null,
            tool_calls: res.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.arguments },
            })),
        });
        if (res.toolCalls.length === 0) {
            // Model answered with prose only; nudge it back into the tool loop.
            messages.push({
                role: "user",
                content: "Continue using the tools. Call done when finished.",
            });
            continue;
        }
        for (const tc of res.toolCalls) {
            if (tc.name === "done") {
                try {
                    doneSummary = String(JSON.parse(tc.arguments || "{}").summary ?? "");
                }
                catch {
                    doneSummary = "(unparsed summary)";
                }
                messages.push({ role: "tool", content: "done acknowledged", tool_call_id: tc.id, name: "done" });
                continue;
            }
            const output = await execTool(workdir, tc.name, tc.arguments);
            messages.push({ role: "tool", content: output, tool_call_id: tc.id, name: tc.name });
        }
    }
    const { diff, changedFiles } = await gitDiff(workdir);
    return {
        turns,
        wallTimeMs: Date.now() - started,
        agentTokens,
        diff,
        changedFiles,
        doneSummary,
        hitTurnCap: doneSummary === null,
        trajectory: messages,
    };
}
// ---------------------------------------------------------------------------
// git helpers (also used by the runner for fixture preparation)
// ---------------------------------------------------------------------------
async function git(workdir, args) {
    const { stdout } = await execFileP2("git", args, { cwd: workdir });
    return stdout;
}
const node_child_process_2 = require("node:child_process");
const execFileP2 = (0, node_util_1.promisify)(node_child_process_2.execFile);
/** Diff of the working tree (incl. untracked files) against HEAD. */
async function gitDiff(workdir) {
    try {
        await git(workdir, ["add", "-A"]);
        const diff = await git(workdir, ["diff", "--cached", "--no-color"]);
        const names = await git(workdir, ["diff", "--cached", "--name-only"]);
        return { diff, changedFiles: names.split("\n").map((s) => s.trim()).filter(Boolean) };
    }
    catch {
        return { diff: "", changedFiles: [] };
    }
}
/**
 * Copy a fixture into a fresh temp dir, git-init it, apply optional oracle
 * setup commands (e.g. a commit that "broke" something), and commit so the
 * post-run diff measures only the agent's changes.
 */
async function prepareRepo(fixtureDir, setup = []) {
    const tmp = await node_fs_1.promises.mkdtemp(node_path_1.default.join(require("node:os").tmpdir(), "intent-exp-"));
    await node_fs_1.promises.cp(fixtureDir, tmp, { recursive: true });
    await git(tmp, ["init", "-q"]);
    await git(tmp, ["add", "-A"]);
    await git(tmp, ["-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-qm", "baseline"]);
    for (const cmd of setup) {
        await execP(cmd, { cwd: tmp, timeout: 60_000 });
        await git(tmp, ["add", "-A"]);
        await git(tmp, ["-c", "user.name=bench", "-c", "user.email=bench@local", "commit", "-qm", `setup: ${cmd.slice(0, 60)}`]);
    }
    return tmp;
}
