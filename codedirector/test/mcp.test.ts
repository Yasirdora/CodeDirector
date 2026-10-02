/**
 * MCP server protocol tests: spawn `cdir mcp` over stdio, connect with the
 * SDK client, list tools, and drive the Lock workflow end to end —
 * lock_draft → lock_check → lock_activate → run_locked (in-budget, then a
 * deny violation that must surface as an error-level result) → report.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import { git, makeGitRepo } from "./helpers";
import { logPath, oldLogPath, recordCall, ROTATE_BYTES, type CallRecord } from "../src/mcp/log";

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

test("mcp: lists the nine workflow tools with schemas and descriptions", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "blast_radius",
      "lock_activate",
      "lock_amend",
      "lock_check",
      "lock_draft",
      "repo_map",
      "report",
      "run_locked",
      "undo",
    ]);
    const amend = tools.find((t) => t.name === "lock_amend")!;
    assert.ok(amend.description!.includes("draft"), "lock_amend explains the draft-only rule");
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

test("mcp: an edited failed lock is refused by run_locked until lock_activate re-approves it", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    const draft = await client.callTool({ name: "lock_draft", arguments: { utterance: "make math faster" } });
    const lockId = JSON.parse(resultText(draft)).lockId as string;
    const lockDir = path.join(root, ".codedirector", "locks");
    const lockFile = path.join(lockDir, fs.readdirSync(lockDir).find((n) => n.startsWith(lockId))!);
    const edit = (f: (y: string) => string) => fs.writeFileSync(lockFile, f(fs.readFileSync(lockFile, "utf8")));
    edit((y) => y.replace("  files: []", '  files:\n    - "src/math.js"').replace("deny: []", 'deny:\n  - "src/secret.js"'));
    assert.ok(!isError(await client.callTool({ name: "lock_activate", arguments: { lockId } })));
    const write = (file: string) => ({
      name: "run_locked",
      arguments: { lockId, command: [NODE, "-e", `require("fs").appendFileSync(${JSON.stringify(file)},"// x\\n")`] },
    });
    assert.ok(isError(await client.callTool(write("src/secret.js"))), "the deny holds: the lock fails");

    // the agent drops the deny by hand and tries again: refused, nothing runs
    edit((y) => y.replace(/^deny:\n(?:  - .*\n)+/m, "deny: []\n"));
    assert.ok(/^deny: \[\]$/m.test(fs.readFileSync(lockFile, "utf8")), "the deny really is gone");
    const again = await client.callTool(write("src/secret.js"));
    assert.ok(isError(again));
    assert.ok(resultText(again).includes("seal mismatch"), resultText(again).slice(0, 300));

    // the human approves the edited scope: the failed lock is re-sealed and runs
    const act = await client.callTool({ name: "lock_activate", arguments: { lockId } });
    assert.ok(!isError(act), resultText(act));
    const ok = await client.callTool(write("src/math.js"));
    assert.ok(!resultText(ok).includes("seal"), resultText(ok).slice(0, 300));
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

test("mcp: lock_draft accepts a profile and rejects an unknown one", async () => {
  const root = makeGitRepo({
    "Sources/App/main.swift": 'print("hi")\n',
    "Package.swift": "// swift-tools-version:5.9\n",
  });
  const { client, close } = await connect(root);
  try {
    const { tools } = await client.listTools();
    const draftTool = tools.find((t) => t.name === "lock_draft")!;
    const props = (draftTool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok("profile" in props, "lock_draft exposes the profile argument");

    const draft = await client.callTool({
      name: "lock_draft",
      arguments: { utterance: "add a greeting screen", profile: "apple" },
    });
    assert.ok(!isError(draft), resultText(draft));
    const lockId = JSON.parse(resultText(draft)).lockId as string;

    // the drafted YAML carries the apple defaults
    const fs = await import("node:fs");
    const lockDir = path.join(root, ".codedirector", "locks");
    const file = fs.readdirSync(lockDir).find((n) => n.startsWith(lockId))!;
    const yaml = fs.readFileSync(path.join(lockDir, file), "utf8");
    assert.ok(yaml.includes("- Pods/**"), "apple deny defaults present");
    assert.ok(yaml.includes("verifyCommand: swift test"), "swift test set for an SPM repo");
    assert.ok(yaml.includes("verifyTimeoutMs: 900000"), "15-minute verify timeout set");

    const bad = await client.callTool({
      name: "lock_draft",
      arguments: { utterance: "add a screen", profile: "windows" },
    });
    assert.ok(isError(bad), "unknown profile is an error");
    assert.match(resultText(bad), /unknown profile "windows"/);
    assert.match(resultText(bad), /available: apple/);
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

test("mcp: home-directory root is refused with instructions; per-call root rescues it", async () => {
  const project = makeGitRepo({ "src/lib.js": "export function helper(){return 1}\n" });
  const { client, close } = await connect(os.homedir());
  try {
    const lost = await client.callTool({ name: "repo_map", arguments: { query: "helper" } });
    assert.ok(isError(lost), "defaulted home root is an error, not a silent home-wide index");
    assert.match(resultText(lost), /home directory/);
    assert.match(resultText(lost), /"root" argument/);

    const rescued = await client.callTool({ name: "repo_map", arguments: { query: "helper", root: project } });
    assert.ok(!isError(rescued), resultText(rescued));
    assert.ok(resultText(rescued).includes("helper"), resultText(rescued));
  } finally {
    await close();
  }
});

function readLog(root: string): CallRecord[] {
  return fs
    .readFileSync(logPath(root), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CallRecord);
}

test("mcp: the flight recorder writes one line per call, with timing and outcome", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    await client.callTool({ name: "repo_map", arguments: { query: "add" } });
    // Missing a required argument: the handler raises and the server turns
    // it into an error result. Recorded as "threw", not "ok".
    await client.callTool({ name: "repo_map", arguments: {} });
  } finally {
    await close();
  }

  const lines = readLog(root);
  assert.equal(lines.length, 2, "one line per call");
  for (const line of lines) {
    assert.equal(line.tool, "repo_map");
    assert.equal(line.root, root);
    assert.ok(Number.isFinite(line.durationMs) && line.durationMs >= 0, "a duration was measured");
    assert.ok(!Number.isNaN(Date.parse(line.at)), "the start time parses");
  }
  assert.equal(lines[0].outcome, "ok");
  assert.equal(lines[1].outcome, "threw", "a raising handler is not recorded as success");
});

test("mcp: the recorder never records the arguments a call was made with", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    await client.callTool({ name: "repo_map", arguments: { query: "a-very-private-phrase" } });
  } finally {
    await close();
  }
  const raw = fs.readFileSync(logPath(root), "utf8");
  assert.ok(!raw.includes("a-very-private-phrase"), "utterances stay out of the log");
});

test("flight recorder: rotates at the cap, keeping one previous file", () => {
  const root = makeGitRepo();
  const file = logPath(root);
  recordCall(root, { at: "2026-01-01T00:00:00.000Z", tool: "t", root, durationMs: 1, outcome: "ok" });
  fs.appendFileSync(file, "x".repeat(ROTATE_BYTES));

  recordCall(root, { at: "2026-01-01T00:00:01.000Z", tool: "t", root, durationMs: 2, outcome: "ok" });

  assert.ok(fs.existsSync(`${file}.1`), "the full log was rolled aside");
  const fresh = readLog(root);
  assert.equal(fresh.length, 1, "the new log holds only what came after the roll");
  assert.equal(fresh[0].durationMs, 2);

  // A second roll replaces the previous .1 rather than accumulating files.
  fs.appendFileSync(file, "x".repeat(ROTATE_BYTES));
  recordCall(root, { at: "2026-01-01T00:00:02.000Z", tool: "t", root, durationMs: 3, outcome: "ok" });
  const siblings = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith("mcp.log"));
  assert.deepEqual(siblings.sort(), ["mcp.log", "mcp.log.1"], "exactly one previous file is kept");
});

test("flight recorder: the log is in .codedirector/runs/, which git ignores — in a new setup and an older one", () => {
  const line = (durationMs: number): CallRecord => ({ at: "2026-01-01T00:00:00.000Z", tool: "t", root: "r", durationMs, outcome: "ok" });
  const fresh = makeGitRepo();
  recordCall(fresh, line(1));
  assert.equal(logPath(fresh), path.join(fresh, ".codedirector", "runs", "mcp.log"));
  assert.equal(readLog(fresh).length, 1);
  git(fresh, ["check-ignore", "-q", ".codedirector/runs/mcp.log"]); // throws when not ignored
  // A project set up by an older version keeps its block in .gitignore: that block covers runs/, nothing new is written.
  const OLD = "# BEGIN cdir\n.codedirector/index.json\n.codedirector/baselines/\n.codedirector/runs/\n.codedirector/ckpt-blobs/\n.codedirector/checkpoints.json\n# END cdir\n";
  const older = makeGitRepo({ "README.md": "# tmp\n", ".gitignore": OLD });
  recordCall(older, line(2));
  git(older, ["check-ignore", "-q", ".codedirector/runs/mcp.log"]);
  assert.equal(fs.existsSync(path.join(older, ".codedirector", ".gitignore")), false);
});

test("flight recorder: a log at the old place, in sight of git, is moved on the next write — with its previous file", () => {
  const root = makeGitRepo();
  fs.mkdirSync(path.join(root, ".codedirector"));
  fs.writeFileSync(oldLogPath(root), JSON.stringify({ at: "2026-01-01T00:00:00.000Z", tool: "old", root, durationMs: 5, outcome: "ok" }) + "\n");
  fs.writeFileSync(`${oldLogPath(root)}.1`, "older\n");
  assert.match(git(root, ["status", "--porcelain", "--untracked-files=all"]), /\.codedirector\/mcp\.log/, "before: git sees it");

  recordCall(root, { at: "2026-01-01T00:00:01.000Z", tool: "new", root, durationMs: 7, outcome: "ok" });
  assert.equal(fs.existsSync(oldLogPath(root)), false);
  assert.equal(fs.existsSync(`${oldLogPath(root)}.1`), false);
  assert.deepEqual(readLog(root).map((r) => r.tool), ["old", "new"], "the old lines are kept, the new one follows");
  assert.equal(fs.readFileSync(`${logPath(root)}.1`, "utf8"), "older\n");
  assert.doesNotMatch(git(root, ["status", "--porcelain", "--untracked-files=all"]), /mcp\.log/, "after: git doesn't");

  // An older server still running writes the old place again: that never replaces the log that's here.
  fs.writeFileSync(oldLogPath(root), "from an older server\n");
  recordCall(root, { at: "2026-01-01T00:00:02.000Z", tool: "newer", root, durationMs: 8, outcome: "ok" });
  assert.deepEqual(readLog(root).map((r) => r.tool), ["old", "new", "newer"]);
});

test("flight recorder: an unwritable destination costs a line, never a throw", () => {
  // A path whose parent is a file, so mkdir cannot succeed.
  const root = makeGitRepo();
  const blocked = path.join(root, "README.md", "nested");
  assert.doesNotThrow(() =>
    recordCall(blocked, {
      at: "2026-01-01T00:00:00.000Z", tool: "t", root: blocked, durationMs: 1, outcome: "ok",
    }),
  );
});

test("mcp: tool schemas advertise the optional root override", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      assert.ok("root" in props, `${t.name} exposes the root override`);
    }
  } finally {
    await close();
  }
});

test("mcp: lock_draft carries KEEP clauses, verifyCommand, accept, and ceilings into the YAML", async () => {
  const root = makeGitRepo({
    "package.json": '{"name":"mcp-keeps","type":"module"}\n',
    "src/math.js": "export function add(a, b) { return a + b; }\n",
    "test/math.test.js":
      'import test from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'import { add } from "../src/math.js";\n' +
      'test("adds", () => assert.equal(add(1, 2), 3));\n',
  });
  const { client, close } = await connect(root);
  try {
    const draft = await client.callTool({
      name: "lock_draft",
      arguments: {
        utterance: "document math without behavior change",
        goal: "the suite still passes",
        keep: [
          { kind: "tests-pass", glob: "test/*.test.js" },
          { kind: "output-unchanged", command: "node -e \"console.log('mcp-keeps')\"" },
          { kind: "no-new-dependency" },
          { kind: "api-unchanged", symbols: ["src/math.js#add"] },
          { kind: "custom", text: "the diff stays small" },
        ],
        verifyCommand: "node --test test/*.test.js",
        accept: ["add still returns a number"],
        budgetFiles: ["src/math.js"],
        maxFiles: 2,
        maxLines: 50,
      },
    });
    assert.ok(!isError(draft), resultText(draft));
    const info = JSON.parse(resultText(draft));
    assert.equal(info.keep.length, 5, "every clause is echoed back");
    assert.equal(info.verifyCommand, "node --test test/*.test.js");
    assert.deepEqual(info.budget.files, ["src/math.js"]);
    assert.equal(info.budget.maxFiles, 2);
    assert.equal(info.budget.maxLines, 50);
    assert.deepEqual(info.accept, ["add still returns a number"]);

    const lockDir = path.join(root, ".codedirector", "locks");
    const file = fs.readdirSync(lockDir).find((n) => n.startsWith(info.lockId))!;
    const yaml = fs.readFileSync(path.join(lockDir, file), "utf8");
    for (const needle of [
      "kind: tests-pass",
      "kind: output-unchanged",
      "kind: no-new-dependency",
      "kind: api-unchanged",
      "kind: custom",
      "verifyCommand: node --test test/*.test.js",
      "maxFiles: 2",
      "add still returns a number",
    ]) {
      assert.ok(yaml.includes(needle), `${needle} is in the drafted YAML:\n${yaml}`);
    }

    const check = await client.callTool({ name: "lock_check", arguments: { lockId: info.lockId } });
    assert.equal(JSON.parse(resultText(check)).ok, true, resultText(check));
    assert.ok(!isError(await client.callTool({ name: "lock_activate", arguments: { lockId: info.lockId } })));

    const run = await client.callTool({
      name: "run_locked",
      arguments: { lockId: info.lockId, command: [NODE, "-e", 'require("fs").appendFileSync("src/math.js","// noted\\n")'] },
    });
    assert.ok(!isError(run), resultText(run));
    assert.ok(resultText(run).includes("tests-pass"), resultText(run).slice(0, 800));

    const repJson = await client.callTool({ name: "report", arguments: { lockId: info.lockId, format: "json" } });
    const report = JSON.parse(resultText(repJson)) as {
      items: Array<{ clauseKind?: string; evidenceClass: string; verdict: string }>;
    };
    const tests = report.items.find((i) => i.clauseKind === "tests-pass");
    assert.equal(tests?.evidenceClass, "measured");
    assert.equal(tests?.verdict, "held");
  } finally {
    await close();
  }
});

test("mcp: lock_amend patches a draft, re-validates, and refuses anything not a draft", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    const draft = await client.callTool({ name: "lock_draft", arguments: { utterance: "make math faster" } });
    const lockId = JSON.parse(resultText(draft)).lockId as string;

    const amend = await client.callTool({
      name: "lock_amend",
      arguments: {
        lockId,
        goal: "same answers, faster",
        keep: [{ kind: "custom", text: "numbers still add up" }],
        budgetFiles: ["src/math.js"],
        deny: ["src/secret.js"],
        maxFiles: 2,
        maxLines: 60,
      },
    });
    assert.ok(!isError(amend), resultText(amend));
    const info = JSON.parse(resultText(amend));
    assert.equal(info.ok, true, `check errors: ${info.errors}`);
    assert.deepEqual(info.budget.files, ["src/math.js"]);
    assert.equal(info.budget.maxFiles, 2);
    assert.equal(info.budget.maxLines, 60);
    assert.equal(info.keep.length, 1);

    const lockDir = path.join(root, ".codedirector", "locks");
    const file = fs.readdirSync(lockDir).find((n) => n.startsWith(lockId))!;
    const yaml = fs.readFileSync(path.join(lockDir, file), "utf8");
    assert.ok(yaml.includes("numbers still add up"), yaml);
    assert.ok(yaml.includes("maxLines: 60"), yaml);

    // an invalid clause is refused, naming the shape it wants
    const bad = await client.callTool({
      name: "lock_amend",
      arguments: { lockId, keep: [{ kind: "api-unchanged" }] },
    });
    assert.ok(isError(bad), "a malformed clause is an error-level result");
    assert.match(resultText(bad), /api-unchanged.*symbols/i);

    // an approved lock is not amendable by a tool — re-approval stays the human's
    assert.ok(!isError(await client.callTool({ name: "lock_activate", arguments: { lockId } })));
    const frozen = await client.callTool({ name: "lock_amend", arguments: { lockId, maxLines: 99 } });
    assert.ok(isError(frozen), "an active lock cannot be amended");
    assert.match(resultText(frozen), /draft/);
  } finally {
    await close();
  }
});

test("mcp: a report refreshes the lock's verdict instead of leaving the last FAILED run", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const draft = await call("lock_draft", { utterance: "keep math tidy", budgetFiles: ["src/math.js"] });
    const lockId = JSON.parse(resultText(draft)).lockId as string;
    await call("lock_check", { lockId });
    const act = await call("lock_activate", { lockId });
    assert.ok(!isError(act), resultText(act));

    const failed = await call("run_locked", { lockId, command: [NODE, "-e", "process.exit(1)"] });
    assert.ok(isError(failed), "a failing command is an error-level result");

    const lockDir = path.join(root, ".codedirector", "locks");
    const lockFile = path.join(lockDir, fs.readdirSync(lockDir).find((n) => n.startsWith(lockId))!);
    assert.match(fs.readFileSync(lockFile, "utf8"), /^status: failed$/m);

    const rep = await call("report", { lockId, format: "json" });
    assert.equal(JSON.parse(resultText(rep)).verdict, "verified");
    assert.match(fs.readFileSync(lockFile, "utf8"), /^status: verified$/m, "the MCP report refreshes the lock's verdict");
  } finally {
    await close();
  }
});

test("mcp: a report on a lock that a later lock has closed shows it as recorded and leaves its status", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const append = (file: string) => [NODE, "-e", "require('fs').appendFileSync('" + file + "','// x\\n')"];
    const start = async (utterance: string, file: string): Promise<string> => {
      const draft = await call("lock_draft", { utterance, budgetFiles: [file] });
      const lockId = JSON.parse(resultText(draft)).lockId as string;
      await call("lock_check", { lockId });
      const act = await call("lock_activate", { lockId });
      assert.ok(!isError(act), resultText(act));
      const ran = await call("run_locked", { lockId, command: append(file) });
      assert.ok(!isError(ran), resultText(ran));
      return lockId;
    };
    const first = await start("keep math tidy", "src/math.js");
    const second = await start("rotate the secret", "src/secret.js");

    const lockDir = path.join(root, ".codedirector", "locks");
    const lockFile = path.join(lockDir, fs.readdirSync(lockDir).find((n) => n.startsWith(first))!);
    assert.match(fs.readFileSync(lockFile, "utf8"), /^status: verified$/m);

    const rep = JSON.parse(resultText(await call("report", { lockId: first, format: "json" })));
    assert.equal(rep.verdict, "verified", JSON.stringify(rep.violations));
    assert.equal(rep.closedBy?.lockId, second);
    assert.match(fs.readFileSync(lockFile, "utf8"), /^status: verified$/m, "the second lock's file did not fail the first");
  } finally {
    await close();
  }
});

test("mcp: lock_draft carries verifyTimeoutMs and lock_amend can set it", async () => {
  const root = makeGitRepo(FILES);
  const { client, close } = await connect(root);
  try {
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const draft = await call("lock_draft", {
      utterance: "document math without behavior change",
      budgetFiles: ["src/math.js"],
      verifyCommand: "npm test",
      verifyTimeoutMs: 424242,
    });
    const info = JSON.parse(resultText(draft));
    assert.equal(info.verifyTimeoutMs, 424242, "the MCP argument is echoed back");
    const dir = path.join(root, ".codedirector", "locks");
    const file = fs.readdirSync(dir).find((n) => n.startsWith(info.lockId))!;
    assert.match(fs.readFileSync(path.join(dir, file), "utf8"), /^verifyTimeoutMs: 424242$/m, "it round-trips through the YAML");

    const amended = await call("lock_amend", { lockId: info.lockId, verifyTimeoutMs: 999 });
    assert.equal(JSON.parse(resultText(amended)).verifyTimeoutMs, 999, "lock_amend patches it too");
  } finally {
    await close();
  }
});
