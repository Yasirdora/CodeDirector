/** Protocol regressions: real stdio servers and real, bounded child checks. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { git, makeGitRepo } from "./helpers";
import { runJob, WorktreeGuard, type Job } from "../src/mcp/jobs";

const CLI = path.join(__dirname, "../src/cli.js");
const NODE = process.execPath;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const body = (r: any): string => r.content.map((c: any) => c.text).join("\n");
const records = (root: string) => fs.readdirSync(path.join(root, ".codedirector/runs")).filter((f) => f.endsWith(".json"));
const marker = (root: string, name: string) => path.join(root, ".codedirector", name);
const sleeper = (root: string, name: string, ms: number) =>
  `require("fs").writeFileSync(${JSON.stringify(marker(root, name))},"started");setTimeout(()=>{},${ms})`;
const shell = (code: string) => `'${NODE.replace(/'/g, "'\\''")}' -e '${code.replace(/'/g, "'\\''")}'`;

async function waitFor(predicate: () => boolean, limit = 10000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    assert.ok(performance.now() - start < limit, "timed out waiting for fixture state");
    await pause(20);
  }
}
async function responsive(action: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await action();
  const ms = performance.now() - start;
  assert.ok(ms < 500, `response took ${ms.toFixed(1)}ms (limit 500ms)`);
  return ms;
}
async function connect(root: string, env?: Record<string, string>) {
  const transport = new StdioClientTransport({ command: NODE, args: ["--liftoff-only", CLI, "mcp", "--root", root], stderr: "pipe", env });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "responsive-test", version: "1" });
  await client.connect(transport);
  const notifications: any[] = [];
  const receive = transport.onmessage!;
  transport.onmessage = (message, ...rest) => {
    if ("method" in message && message.method === "notifications/progress") notifications.push(message);
    receive(message, ...rest);
  };
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const draft = async (args: Record<string, unknown> = {}) => {
    const r = await call("lock_draft", { utterance: "test MCP responsiveness", budgetFiles: ["src/a.js"], ...args });
    assert.ok(!r.isError, body(r));
    const id = JSON.parse(body(r)).lockId;
    const activated = await call("lock_activate", { lockId: id });
    assert.ok(!activated.isError, body(activated));
    return id as string;
  };
  return { client, transport, call, draft, notifications };
}
const fixture = () => makeGitRepo({ "src/a.js": "export const a = 1;\n" });

test("MCP: 65s verification stays responsive, emits token-scoped liveness, and survives a 60s client timeout", { timeout: 100000 }, async (t) => {
  const root = fixture();
  const c = await connect(root);
  t.after(() => c.client.close());
  const code = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(marker(root, "checking"))},"yes");setTimeout(()=>{},Number(fs.readFileSync(${JSON.stringify(marker(root, "delay"))},"utf8")))`;
  const lockId = await c.draft({ verifyCommand: shell(code) });
  fs.writeFileSync(marker(root, "delay"), "65000");
  const pulses: Array<{ at: number; progress: number; total?: number }> = [];
  const start = performance.now();
  const run = c.client.callTool({ name: "run_locked", arguments: { lockId, command: [NODE, "-e", "void 0"], testTimeoutMs: 90000 } }, CallToolResultSchema, {
    timeout: 60000, resetTimeoutOnProgress: true,
    onprogress: (p) => { pulses.push({ at: performance.now(), progress: p.progress, total: p.total }); },
  });
  await waitFor(() => fs.existsSync(marker(root, "checking")));
  const pingMs = await responsive(() => c.client.ping());
  const listMs = await responsive(() => c.client.listTools());
  // A separate worktree must not inherit this repository's busy state.
  const other = fixture();
  const independent = await c.call("repo_map", { root: other, query: "a" });
  assert.ok(!independent.isError, body(independent));
  for (const name of ["run_locked", "report", "undo", "lock_activate", "lock_amend", "lock_draft", "lock_check", "repo_map"]) {
    await responsive(async () => {
      const r = await c.call(name, { lockId, command: [NODE, "-e", "void 0"] });
      assert.ok(r.isError && body(r).includes("repository busy"), `${name}: ${body(r)}`);
    });
  }
  const result = await run;
  const elapsed = performance.now() - start;
  assert.ok(!result.isError, body(result));
  assert.match(body(result), /Done — verified/);
  assert.ok(elapsed >= 65000);
  assert.ok(pulses.length >= 13, `only ${pulses.length} liveness notifications`);
  for (let i = 0; i < pulses.length; i++) {
    assert.equal(pulses[i].total, undefined, "no fabricated completion percentage");
    if (i) {
      assert.ok(pulses[i].progress > pulses[i - 1].progress);
      assert.ok(pulses[i].at - pulses[i - 1].at < 5500, "5s cadence with 500ms scheduling tolerance");
    }
  }
  assert.equal(new Set(c.notifications.map((n) => n.params.progressToken)).size, 1);
  assert.equal(records(root).length, 1);
  t.diagnostic(`65s check: ping ${pingMs.toFixed(1)}ms; list ${listMs.toFixed(1)}ms; final ${elapsed.toFixed(1)}ms; ${pulses.length} pulses`);
  // Standalone report re-runs verification: it needs the same boundary.
  fs.writeFileSync(marker(root, "delay"), "2000");
  fs.unlinkSync(marker(root, "checking"));
  const before = c.notifications.length;
  const report = c.call("report", { lockId, format: "json" });
  await waitFor(() => fs.existsSync(marker(root, "checking")));
  await responsive(() => c.client.ping());
  await responsive(() => c.client.listTools());
  assert.equal(JSON.parse(body(await report)).verdict, "verified");
  assert.equal(c.notifications.length, before, "no token means no progress notifications");
});

test("MCP: standalone report sends its own token-scoped liveness", { timeout: 15000 }, async (t) => {
  const root = fixture();
  const c = await connect(root);
  t.after(() => c.client.close());
  const delay = marker(root, "delay");
  const lockId = await c.draft({ verifyCommand: shell(`setTimeout(()=>{},Number(require("fs").readFileSync(${JSON.stringify(delay)},"utf8")))`) });
  fs.writeFileSync(delay, "0");
  assert.ok(!(await c.call("run_locked", { lockId, command: [NODE, "-e", "void 0"] })).isError);
  fs.writeFileSync(delay, "6000");
  const pulses: number[] = [];
  const report = await c.client.callTool({ name: "report", arguments: { lockId } }, CallToolResultSchema,
    { onprogress: (p) => { pulses.push(p.progress); assert.equal(p.total, undefined); } });
  assert.ok(!report.isError);
  assert.ok(pulses.length >= 2, "standalone report has both initial and 5s liveness");
  assert.ok(c.notifications.every((n) => n.params.message.startsWith("report still running")));
});

test("guard: plain directories work without Git; nested Git roots still share ownership", async (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-plain-"));
  fs.writeFileSync(path.join(plain, "a.js"), "export const plain = 1;\n");
  const c = await connect(plain, { PATH: plain });
  t.after(() => c.client.close());
  const result = await c.call("repo_map", { query: "plain" });
  assert.ok(!result.isError, body(result));
  const guard = new WorktreeGuard();
  (await guard.acquire(plain, "repo_map"))(); // Git available, but not a repo
  const root = fixture();
  const script = `
    const {WorktreeGuard}=require(${JSON.stringify(path.join(__dirname, "../src/mcp/jobs.js"))});
    const assert=require("node:assert/strict");
    (async()=>{
      const guard=new WorktreeGuard();
      const release=await guard.acquire(${JSON.stringify(root)},"run_locked");
      await assert.rejects(guard.acquire(${JSON.stringify(path.join(root, "src"))},"undo"),/repository busy/);
      release();
      (await guard.acquire(${JSON.stringify(plain)},"repo_map"))();
    })().catch(e=>{console.error(e);process.exitCode=1});`;
  const child = spawnSync(NODE, ["--liftoff-only", "-e", script], {
    env: { ...process.env, PATH: plain }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(child.status, 0, child.stderr);
  // A malformed .git is not the same as an absent Git executable.
  fs.writeFileSync(path.join(plain, ".git"), "gitdir: /nonexistent/cdir-audit-repo\n");
  await assert.rejects(guard.acquire(plain, "repo_map"));
});

test("MCP: baseline probe and locked command are off-thread; aliases share the guard", { timeout: 25000 }, async (t) => {
  const root = fixture();
  const c = await connect(root);
  t.after(() => c.client.close());
  const lockId = await c.draft({ keep: [{ kind: "output-unchanged", command: shell(sleeper(root, "baseline", 1200)) }] });
  const run = c.call("run_locked", { lockId, command: [NODE, "-e", sleeper(root, "command", 6000)] });
  await waitFor(() => fs.existsSync(marker(root, "baseline")));
  await responsive(() => c.client.ping());
  await waitFor(() => fs.existsSync(marker(root, "command")));
  await responsive(() => c.client.ping());
  await responsive(() => c.client.listTools());
  const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-alias-"));
  const alias = path.join(aliasDir, "repo");
  fs.symlinkSync(root, alias, "dir");
  for (const aliasRoot of [alias, path.join(root, "src")]) {
    const r = await c.call("undo", { root: aliasRoot });
    assert.ok(r.isError && body(r).includes("repository busy"), body(r));
  }
  assert.ok(!(await run).isError);
  assert.equal(c.notifications.length, 0, "even a >5s command sends nothing without a token");
  const log = fs.readFileSync(marker(root, "runs/mcp.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(log.filter((r) => r.tool === "run_locked").length, 1, "one completion entry");
  assert.ok(!(await c.call("report", { lockId })).isError, "guard released after completion");
});

for (const cancel of ["abort", "timeout"] as const) {
  test(`MCP: ${cancel} keeps the guard and saves one recoverable run`, { timeout: 20000 }, async (t) => {
    const root = fixture();
    const c = await connect(root);
    t.after(() => c.client.close());
    const lockId = await c.draft();
    const controller = new AbortController();
    const run = c.client.callTool({ name: "run_locked", arguments: { lockId, command: [NODE, "-e", sleeper(root, "started", 2500)] } }, CallToolResultSchema,
      { signal: controller.signal, timeout: cancel === "timeout" ? 1000 : 10000 });
    const rejected = assert.rejects(run, cancel === "timeout" ? /timed out/ : /audit cancellation/);
    await waitFor(() => fs.existsSync(marker(root, "started")));
    if (cancel === "abort") controller.abort(new Error("audit cancellation"));
    await rejected;
    const busy = await c.call("undo", {});
    assert.ok(busy.isError && body(busy).includes("repository busy"));
    await responsive(() => c.client.ping());
    await waitFor(() => records(root).length === 1);
    // A written record precedes worker exit; wait for the completion log.
    await waitFor(() => fs.readFileSync(marker(root, "runs/mcp.log"), "utf8").includes('"tool":"run_locked"'));
    assert.equal(JSON.parse(body(await c.call("report", { lockId, format: "json" }))).verdict, "verified");
    assert.equal(records(root).length, 1, "cancellation never retries");
  });
}

test("MCP: worker errors release the guard; verdicts and seals still fail closed", async (t) => {
  const root = fixture();
  const c = await connect(root);
  t.after(() => c.client.close());
  const lockId = await c.draft({ verifyCommand: shell("setTimeout(()=>{},1500)") });
  const run = (id: string, command: string[], testTimeoutMs = 5000) => c.call("run_locked", { lockId: id, command, testTimeoutMs });
  assert.match(body(await run("IL-9999", [NODE, "-e", "void 0"])), /no such lock/);
  const incomplete = await run(lockId, [NODE, "-e", "void 0"], 100);
  assert.ok(incomplete.isError);
  assert.match(body(incomplete), /NOT VERIFIED/);
  const failed = await run(lockId, [NODE, "-e", "process.exit(7)"]);
  assert.ok(failed.isError);
  assert.match(body(failed), /FAILED/);
  const file = path.join(root, ".codedirector/locks", fs.readdirSync(marker(root, "locks"))[0]);
  fs.appendFileSync(file, '\n# comments do not change the seal\n');
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("goal:", "goal: tampered #"));
  const sealed = await run(lockId, [NODE, "-e", "void 0"]);
  assert.ok(sealed.isError);
  assert.match(body(sealed), /seal mismatch/);
});

test("worker startup, crash and result-less exit reject; stdout cannot become protocol; flags inherit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-worker-"));
  const job: Job = { kind: "report", root: dir, lockId: "IL-0001", format: "json" };
  await assert.rejects(runJob(job, path.join(dir, "missing.js")), /Cannot find module/);
  for (const code of ['throw Error("worker crashed")', "process.exit(0)", "process.exit(2)"]) {
    const entry = path.join(dir, "exit.cjs");
    fs.writeFileSync(entry, code);
    await assert.rejects(runJob(job, entry), /worker crashed|without a result|exited 2/);
  }
  const entry = path.join(dir, "flags.cjs");
  fs.writeFileSync(entry, 'console.log("not protocol");require("node:worker_threads").parentPort.postMessage({result:{content:[{type:"text",text:JSON.stringify(process.execArgv)}]}})');
  assert.deepEqual(JSON.parse(body(await runJob(job, entry))), process.execArgv);
});

test("guard excludes nested projects but permits a distinct linked Git worktree", async () => {
  const root = fixture();
  const linked = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdir-linked-")), "worktree");
  git(root, ["worktree", "add", "--detach", linked, "HEAD"]);
  const guard = new WorktreeGuard();
  const release = await guard.acquire(root, "run_locked");
  await assert.rejects(guard.acquire(path.join(root, "src"), "undo"), /repository busy/);
  const releaseLinked = await guard.acquire(linked, "report");
  releaseLinked();
  release();
  (await guard.acquire(root, "report"))();
});

test("MCP: graceful input EOF drains the job and saves its final record", { timeout: 20000 }, async () => {
  const root = fixture();
  const child = spawn(NODE, ["--liftoff-only", CLI, "mcp", "--root", root], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const exit = once(child, "exit");
  let nextId = 0, buffer = "";
  const waiting = new Map<number, (r: any) => void>();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting.get(message.id)?.(message.result);
      waiting.delete(message.id);
    }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "eof-test", version: "1" } });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const draft = await request("tools/call", { name: "lock_draft", arguments: { utterance: "EOF test", budgetFiles: ["src/a.js"] } });
    const lockId = JSON.parse(body(draft)).lockId;
    await request("tools/call", { name: "lock_activate", arguments: { lockId } });
    void request("tools/call", { name: "run_locked", arguments: { lockId, command: [NODE, "-e", sleeper(root, "started", 2500)] } });
    await waitFor(() => fs.existsSync(marker(root, "started")));
    child.stdin.end();
    const [code] = await exit;
    assert.equal(code, 0);
    assert.equal(records(root).length, 1);
    assert.match(fs.readFileSync(marker(root, "runs/mcp.log"), "utf8"), /"tool":"run_locked"/);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
