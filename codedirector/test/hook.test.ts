/**
 * Hook bridge tests: PreToolUse decisions against the active Lock —
 * deny list, budget membership, jurisdiction, self-management, and the
 * fail-open guarantees the hook contract requires.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { VibeCheck, LOCK_SCHEMA_VERSION } from "../src/lock/types";
import { saveLock } from "../src/lock/store";
import { decidePreToolUse, targetFileOf, runHookCommand } from "../src/hook/index";
import { copyDemoRepo } from "./helpers";

function lockWith(overrides: Partial<VibeCheck>): VibeCheck {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id: "IL-0001",
    status: "active",
    utterance: "make the preview feel instant",
    goal: "input-to-paint under 50ms during drag",
    interpretation: "p95 drag latency < 50ms",
    keep: [],
    deny: ["src/export.ts", "package-lock.json", "secrets/**"],
    change: "preview responsiveness only",
    budget: { files: ["src/preview.ts", "src/slider.ts"], symbols: [], maxFiles: 3, maxLines: 200 },
    accept: [],
    assumptions: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    createdBy: "test",
    ...overrides,
  };
}

function editPayload(filePath: string) {
  return { tool_name: "Edit", tool_input: { file_path: filePath } };
}

test("targetFileOf reads the common key spellings", () => {
  assert.equal(targetFileOf({ file_path: "a.ts" }), "a.ts");
  assert.equal(targetFileOf({ filePath: "b.ts" }), "b.ts");
  assert.equal(targetFileOf({ path: "c.ts" }), "c.ts");
  assert.equal(targetFileOf({ notebook_path: "d.ipynb" }), "d.ipynb");
  assert.equal(targetFileOf({ command: "rm -rf x" }), null);
});

test("non-edit tools are always allowed", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const d = decidePreToolUse(root, { tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(d.action, "allow");
});

test("no active lock reminds instead of blocking", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({ status: "draft" }));
  const d = decidePreToolUse(root, editPayload("src/export.ts"));
  assert.equal(d.action, "remind");
  if (d.action === "remind") assert.match(d.message, /no active Vibe Check/);
});

test("denied file is blocked with the lock id and utterance in the reason", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const d = decidePreToolUse(root, editPayload("src/export.ts"));
  assert.equal(d.action, "block");
  if (d.action === "block") {
    assert.match(d.reason, /IL-0001/);
    assert.match(d.reason, /make the preview feel instant/);
    assert.match(d.reason, /deny list/);
  }
});

test("deny globs match nested paths", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const d = decidePreToolUse(root, editPayload("secrets/prod/token.txt"));
  assert.equal(d.action, "block");
});

test("in-budget file is allowed", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  assert.equal(decidePreToolUse(root, editPayload("src/preview.ts")).action, "allow");
});

test("out-of-budget file is blocked and the reason names the budget", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const d = decidePreToolUse(root, editPayload("src/pipeline.ts"));
  assert.equal(d.action, "block");
  if (d.action === "block") {
    assert.match(d.reason, /outside the approved budget/);
    assert.match(d.reason, /src\/preview\.ts/);
    assert.match(d.reason, /ask the user/);
  }
});

test("paths outside the project root are blocked", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const d = decidePreToolUse(root, editPayload("/etc/hostname"));
  assert.equal(d.action, "block");
  if (d.action === "block") assert.match(d.reason, /outside the project root/);
});

test(".codedirector state is always writable (the layer manages itself)", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const d = decidePreToolUse(root, editPayload(".codedirector/locks/IL-0001-x.yaml"));
  assert.equal(d.action, "allow");
});

test("an active lock file is sealed: edits blocked; drafts, finished locks, other state allowed", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({})); // active IL-0001
  const activeFile = ".codedirector/locks/IL-0001-make-the-preview-feel-instant.yaml";
  const d = decidePreToolUse(root, editPayload(activeFile));
  assert.equal(d.action, "block");
  if (d.action === "block") {
    assert.match(d.reason, /active, sealed Vibe Check/);
    assert.match(d.reason, /lock check \+ lock activate to re-seal/);
  }
  // drafts MUST stay editable (pre-approval), verified/failed are history
  saveLock(root, lockWith({ id: "IL-0002", status: "draft" }));
  assert.equal(
    decidePreToolUse(root, editPayload(".codedirector/locks/IL-0002-make-the-preview-feel-instant.yaml")).action,
    "allow",
  );
  saveLock(root, lockWith({ id: "IL-0003", status: "verified" }));
  assert.equal(
    decidePreToolUse(root, editPayload(".codedirector/locks/IL-0003-make-the-preview-feel-instant.yaml")).action,
    "allow",
  );
  // everything else under .codedirector stays writable
  assert.equal(decidePreToolUse(root, editPayload(".codedirector/index.json")).action, "allow");
  assert.equal(decidePreToolUse(root, editPayload(".codedirector/seals.json")).action, "allow");
});

test("budget globs are honored", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({ budget: { files: ["src/**"], symbols: [], maxFiles: 9, maxLines: 999 } }));
  assert.equal(decidePreToolUse(root, editPayload("src/anywhere/deep.ts")).action, "allow");
});

test("absolute in-root paths resolve to root-relative before matching", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const d = decidePreToolUse(root, editPayload(`${root}/src/preview.ts`));
  assert.equal(d.action, "allow");
});

test("unknown tool_input shapes fail open even with an active lock", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const d = decidePreToolUse(root, { tool_name: "Write", tool_input: { content: "..." } });
  assert.equal(d.action, "allow");
});

test("a finished lock no longer gates edits", () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({ status: "verified" }));
  const d = decidePreToolUse(root, editPayload("src/export.ts"));
  assert.equal(d.action, "remind"); // no ACTIVE lock → workflow reminder, not a block
});

test("malformed payloads fail open", () => {
  const root = copyDemoRepo();
  assert.equal(decidePreToolUse(root, {}).action, "allow");
  assert.equal(decidePreToolUse(root, { tool_name: "Edit" }).action, "remind");
});

/** Capture stdout/stderr writes around one runHookCommand call. */
async function captureHook(root: string, stdinText: string) {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    const code = await runHookCommand(root, stdinText);
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("runHookCommand block emits deny JSON on stdout, reason on stderr, exit 2", async () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const r = await captureHook(root, JSON.stringify(editPayload("src/export.ts")));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /deny list/);
  const wire = JSON.parse(r.stdout.trim());
  assert.equal(wire.decision, "deny");
  assert.match(wire.reason, /IL-0001/);
});

test("runHookCommand remind emits allow with additionalContext, exit 0", async () => {
  const root = copyDemoRepo();
  const r = await captureHook(root, JSON.stringify(editPayload("src/anything.ts")));
  assert.equal(r.code, 0);
  const wire = JSON.parse(r.stdout.trim());
  assert.equal(wire.decision, "allow");
  assert.match(wire.message, /no active Vibe Check/);
  assert.equal(wire.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(wire.hookSpecificOutput.additionalContext, /no active Vibe Check/);
});

test("runHookCommand allow stays silent and exits 0", async () => {
  const root = copyDemoRepo();
  saveLock(root, lockWith({}));
  const r = await captureHook(root, JSON.stringify(editPayload("src/preview.ts")));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("runHookCommand fails open on unparseable stdin", async () => {
  const root = copyDemoRepo();
  const r = await captureHook(root, "not json at all {");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});
