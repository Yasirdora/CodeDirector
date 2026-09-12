/**
 * MCP server protocol tests: spawn `cdir mcp` over stdio, connect with the
 * SDK client, list tools, and drive the Lock workflow end to end —
 * lock_draft → lock_check → lock_activate → run_locked (in-budget, then a
 * deny violation that must surface as an error-level result) → report.
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeGitRepo } from "./helpers";

const CLI = path.join(__dirname, "..", "src", "cli.js");
const NODE = process.execPath;

const FILES = {
  "src/math.js": `export function add(a, b) { return a + b; }\n`,
  "src/secret.js": `export const SECRET = 1;\n`,
};

interface Connected {
  client: Client;
  close: () => Promise<void>;
}

async function connect(root: string): Promise<Connected> {
  const transport = new StdioClientTransport({
    command: NODE,
    args: [CLI, "mcp", "--root", root],
    stderr: "pipe",
  });
  const client = new Client({ name: "cdir-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

function resultText(r: unknown): string {
  const content = (r as { content: Array<{ type: string; text: string }> }).content;
  return content.map((c) => c.text).join("\n");
}
function isError(r: unknown): boolean {
  return (r as { isError?: boolean }).isError === true;
}

test("mcp: lists the eight workflow tools with schemas and descriptions", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "blast_radius",
      "lock_activate",
      "lock_check",
      "lock_draft",
      "repo_map",
      "report",
      "run_locked",
      "undo",
    ]);
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 40, `${t.name} has a real description`);
      assert.ok(t.inputSchema && typeof t.inputSchema === "object", `${t.name} has an input schema`);
    }
    // run_locked must warn about the workflow order
    const run = tools.find((t) => t.name === "run_locked")!;
    assert.ok(run.description!.includes("checkpoint") && run.description!.includes("deny"));
  } finally {
    await close();
  }
});

test("mcp: full workflow — draft, activate, in-budget run, deny violation is an error", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    // draft
    const draft = await client.callTool({ name: "lock_draft", arguments: { utterance: "make math faster", goal: "same behavior, faster" } });
    assert.ok(!isError(draft), resultText(draft));
    const draftInfo = JSON.parse(resultText(draft));
    const lockId = draftInfo.lockId as string;
    assert.match(lockId, /^IL-\d{4}$/);
    assert.ok(draftInfo.path.includes(".codedirector/locks/"), draftInfo.path);
    assert.ok(Array.isArray(draftInfo.proposedBudget), "proposed budget present for the human to review");

    // the human/agent sets the scope in the YAML (draft abstains on weak anchors)
    const fs = await import("node:fs");
    const lockDir = path.join(root, ".codedirector", "locks");
    const setBudget = (id: string, files: string[], deny?: string[]) => {
      const f = fs.readdirSync(lockDir).find((n) => n.startsWith(id))!;
      const p = path.join(lockDir, f);
      let t = fs.readFileSync(p, "utf8");
      t = t.replace("  files: []", "  files:\n" + files.map((x) => `    - "${x}"`).join("\n"));
      if (deny) t = t.replace("deny: []", "deny:\n" + deny.map((x) => `  - "${x}"`).join("\n"));
      fs.writeFileSync(p, t);
    };
    setBudget(lockId, ["src/math.js"]);

    // check + activate
    const check = await client.callTool({ name: "lock_check", arguments: { lockId } });
    assert.ok(!isError(check), resultText(check));
    const checkInfo = JSON.parse(resultText(check));
    assert.equal(checkInfo.ok, true, `check errors: ${checkInfo.errors}`);

    // running a DRAFT must fail — activation is a real gate
    const early = await client.callTool({
      name: "run_locked",
      arguments: { lockId, command: [NODE, "-e", 'require("fs").appendFileSync("src/math.js","// x\\n")'] },
    });
    assert.ok(isError(early), "draft lock cannot run");

    const act = await client.callTool({ name: "lock_activate", arguments: { lockId } });
    assert.ok(!isError(act), resultText(act));

    // in-budget run
    const run = await client.callTool({
      name: "run_locked",
      arguments: { lockId, command: [NODE, "-e", 'require("fs").appendFileSync("src/math.js","// faster\\n")'] },
    });
    assert.ok(!isError(run), resultText(run));
    const runText = resultText(run);
    assert.ok(runText.startsWith(`run ${lockId} succeeded`), runText.slice(0, 120));
    assert.ok(runText.includes("Done — verified."), "plain summary on top of the report");
    assert.ok(runText.includes("Only src/math.js changed, within the agreed scope."), runText.slice(0, 400));

    // report tool renders the same summary
    const rep = await client.callTool({ name: "report", arguments: { lockId } });
    assert.ok(resultText(rep).includes("Done — verified."));
    const repJson = await client.callTool({ name: "report", arguments: { lockId, format: "json" } });
    const parsed = JSON.parse(resultText(repJson));
    assert.equal(parsed.verdict, "verified");
    assert.equal(parsed.lockId, lockId);

    // deny violation via MCP is an error-level result naming the path
    const draft2 = await client.callTool({ name: "lock_draft", arguments: { utterance: "tune math again" } });
    const lock2 = JSON.parse(resultText(draft2)).lockId as string;
    // scope: math.js in budget, secret.js denied
    setBudget(lock2, ["src/math.js"], ["src/secret.js"]);
    const act2 = await client.callTool({ name: "lock_activate", arguments: { lockId: lock2 } });
    assert.ok(!isError(act2), resultText(act2));
    const bad = await client.callTool({
      name: "run_locked",
      arguments: { lockId: lock2, command: [NODE, "-e", 'require("fs").appendFileSync("src/secret.js","// pwn\\n")'] },
    });
    assert.ok(isError(bad), "deny violation must be an error-level result");
    const badText = resultText(bad);
    assert.ok(badText.includes("FAILED"), badText.slice(0, 200));
    assert.ok(badText.includes("DENY: src/secret.js"), badText);
    assert.ok(badText.includes("Blocked: src/secret.js is off-limits."), "plain blocked summary");

    // undo refuses without force (checkpoint covered a dirty tree)...
    const unRefused = await client.callTool({ name: "undo", arguments: {} });
    assert.ok(isError(unRefused), "dirty-tree checkpoint refuses undo without force");
    assert.ok(resultText(unRefused).includes("refusing to undo"), resultText(unRefused).slice(0, 200));
    // ...and restores with force when the human discards the failed work
    const un = await client.callTool({ name: "undo", arguments: { force: true } });
    assert.ok(!isError(un), resultText(un));
    const undoInfo = JSON.parse(resultText(un));
    assert.ok(undoInfo.restoredTag.startsWith("cdir/ckpt-"), undoInfo.restoredTag);
  } finally {
    await close();
  }
});

test("mcp: repo_map and blast_radius answer over MCP", async () => {
  const root = makeGitRepo({
    "src/lib.js": "export function helper(){return 1}\n",
    "src/use.js": 'import { helper } from "./lib.js";\nexport function caller(){ return helper(); }\n',
  });
  const { client, close } = await connect(root);
  try {
    const map = await client.callTool({ name: "repo_map", arguments: { query: "helper" } });
    assert.ok(!isError(map), resultText(map));
    assert.ok(resultText(map).includes("helper"), resultText(map));

    const why = await client.callTool({ name: "blast_radius", arguments: { symbol: "helper" } });
    assert.ok(!isError(why), resultText(why));
    assert.ok(resultText(why).includes("caller"), resultText(why));

    const missing = await client.callTool({ name: "blast_radius", arguments: { symbol: "noSuchSymbol" } });
    assert.ok(isError(missing), "unknown symbol is an error");
  } finally {
    await close();
  }
});
