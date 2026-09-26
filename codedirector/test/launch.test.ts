/**
 * The entry point (src/cli.ts) starts cdir with the V8 flags its Swift
 * grammar needs, however cdir is launched. Without them Node 24 crashes at
 * exit after parsing Swift ("Fatal process out of memory: Zone", exit 133);
 * Node 22 stalls ~8s. These tests run the CLI the way users and MCP clients
 * do — `node cli.js …`, with no flags.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { makeGitRepo } from "./helpers";

const CLI = path.join(__dirname, "..", "src", "cli.js");
const SWIFT = { "Sources/App/Model.swift": "public struct Model {\n  public func refresh() -> Int { 1 }\n}\n" };

test("launch: `node cli.js` parses Swift and exits cleanly, without a warning", () => {
  const root = makeGitRepo(SWIFT);
  const r = spawnSync(process.execPath, [CLI, "index", "--root", root], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `exit ${r.status} ${r.signal ?? ""}: ${r.stderr.slice(0, 300)}`);
  assert.doesNotMatch(r.stderr, /Fatal|started without/, "the relaunched process has the flags");
});

test("launch: the exit status of the command comes through the relaunch", () => {
  const root = makeGitRepo(SWIFT);
  const r = spawnSync(process.execPath, [CLI, "lock", "show", "IL-9999", "--root", root], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /IL-9999/);
});

test("launch: what cdir runs does not inherit the relaunch guard (a nested cdir decides for itself)", async () => {
  const root = makeGitRepo({ ...SWIFT, "notes.md": "x\n" });
  spawnSync(process.execPath, [CLI, "lock", "new", "edit notes", "--root", root, "--budget-files", "notes.md"], { timeout: 60_000 });
  spawnSync(process.execPath, [CLI, "lock", "activate", "IL-0001", "--root", root], { timeout: 60_000 });
  const probe = `require("fs").writeFileSync("notes.md", process.env.CDIR_RELAUNCHED === undefined ? "clean\\n" : "leaked\\n")`;
  const r = spawnSync(process.execPath, [CLI, "run", "IL-0001", "--root", root, "--no-report", "--", process.execPath, "-e", probe], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(require("node:fs").readFileSync(path.join(root, "notes.md"), "utf8"), "clean\n");
});

test("launch: SIGTERM to the launcher reaches the relaunched cdir (an MCP client stopping its server)", async () => {
  const server = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    server.on("exit", (code, signal) => resolve({ code, signal })),
  );
  let childPid: number | undefined;
  try {
    // Wait until the relaunched process exists.
    for (let i = 0; i < 100 && childPid === undefined; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const out = spawnSync("pgrep", ["-P", String(server.pid)], { encoding: "utf8" }).stdout.trim();
      if (out) childPid = Number(out.split("\n")[0]);
    }
    assert.ok(childPid, "the launcher relaunched cdir");
    server.kill("SIGTERM");
    const result = await exited;
    assert.equal(result.signal, "SIGTERM", "the launcher ends the way the relaunched process did");
    // The relaunched process is gone (or a zombie awaiting reaping — not running).
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(childPid)], { encoding: "utf8" }).stdout.trim();
    assert.ok(state === "" || state.startsWith("Z"), `relaunched cdir still running: ${state}`);
  } finally {
    // A failing assertion must fail the test, not leave a server that keeps it open.
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    if (childPid !== undefined) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
});

test("launch: a program that parses Swift without the flags is told so, instead of crashing silently", () => {
  // Parse, then kill the process before exit — where the crash or stall would come.
  const parser = path.join(__dirname, "..", "src", "core", "parser.js");
  const script =
    `const {StructuralParser}=require(${JSON.stringify(parser)});` +
    `(async()=>{const p=new StructuralParser();await p.init();p.parseFile("A.swift","struct A {}\\n","h");` +
    `process.kill(process.pid,"SIGKILL")})()`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60_000 });
  assert.match(r.stderr, /parsing Swift in a Node process started without --liftoff-only/);
});
