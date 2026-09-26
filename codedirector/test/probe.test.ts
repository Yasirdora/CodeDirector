/**
 * The probe supervisor (run/supervise.ts): a timed-out check stops with
 * everything it started, output has no memory ceiling, and a hash always
 * covers the whole output.
 *
 * Liveness is judged by behaviour — does a background writer keep writing
 * after the probe returned? — not by pid, because a killed process can stay
 * a zombie until the system reaps it.
 */

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { KILL_GRACE_MS, MAX_CAPTURED_BYTES, runArgvProbe, runShellProbe } from "../src/run/probe";
import { buildIndex } from "../src/core/builder";
import { captureBaseline } from "../src/run/baseline";
import { verifyWithBaseline } from "../src/verify/verify";
import { LOCK_SCHEMA_VERSION, VibeCheck } from "../src/lock/types";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdir-probe-test-"));
}

/** A node one-liner that appends a tick to `file` every 50ms, forever. */
function ticker(file: string): string {
  return `${JSON.stringify(NODE)} -e 'setInterval(()=>require("fs").appendFileSync(${JSON.stringify(file)},"."),50)'`;
}

function stillWriting(file: string, ms = 600): boolean {
  const before = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* wait */
  }
  const after = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return after > before;
}

test("probe: a timeout stops the command and everything it started", () => {
  const dir = tmp();
  const ticks = path.join(dir, "ticks");
  const started = Date.now();
  const r = runShellProbe(dir, `${ticker(ticks)} & sleep 30`, 800);
  const took = Date.now() - started;
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.ok(took < 800 + KILL_GRACE_MS + 2000, `returned after ${took}ms`);
  assert.ok(fs.existsSync(ticks), "the background process ran");
  assert.equal(stillWriting(ticks), false, "the background process was stopped with the command");
});

test("probe: a command that ignores SIGTERM is stopped by force after the grace period", () => {
  const dir = tmp();
  const ticks = path.join(dir, "ticks");
  const r = runShellProbe(dir, `trap "" TERM; ${ticker(ticks).replace("setInterval", "process.on(\"SIGTERM\",()=>{});setInterval")}`, 800);
  assert.equal(r.timedOut, true);
  assert.equal(stillWriting(ticks), false);
});

test("probe: a command that finishes on its own may leave a daemon running (it is not a timeout)", () => {
  const dir = tmp();
  const ticks = path.join(dir, "ticks");
  const pidFile = path.join(dir, "pid");
  const r = runShellProbe(dir, `${ticker(ticks)} & echo $! > ${JSON.stringify(pidFile)}; exit 0`, 10_000);
  try {
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.equal(stillWriting(ticks), true, "left alone, as a build daemon would be");
  } finally {
    try {
      process.kill(Number(fs.readFileSync(pidFile, "utf8").trim()), "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

test("probe: output past the in-memory cap keeps its end, and the hash covers all of it", () => {
  const dir = tmp();
  const total = MAX_CAPTURED_BYTES + 1_000_000;
  const script = `const b=Buffer.alloc(${total - 13},"x");process.stdout.write(b);process.stdout.write("\\nfinal error\\n");console.error("err line")`;
  const r = runArgvProbe(dir, [NODE, "-e", script], 60_000);
  assert.equal(r.exitCode, 0, r.error);
  assert.equal(r.error, undefined, "no ENOBUFS: the output never sat in a pipe buffer");
  assert.deepEqual(r.omitted, { stdout: total - MAX_CAPTURED_BYTES });
  assert.ok(r.stdout.startsWith("[cdir: the first "), "the cut is announced");
  assert.ok(r.stdout.endsWith("\nfinal error\n"), "the end — where diagnostics are — is kept");
  const full = Buffer.concat([Buffer.alloc(total - 13, "x"), Buffer.from("\nfinal error\n")]);
  assert.equal(r.stdoutSha256, crypto.createHash("sha256").update(full).digest("hex"));
  assert.equal(r.stderr, "err line\n");
});

test("probe: output-unchanged sees a difference hidden in the part of a long output that is not kept", async () => {
  // Same length, same end — only the first byte differs, inside the cut.
  const root = makeGitRepo({ "mode.txt": "a\n" });
  const script =
    `const f=require("fs");const m=f.readFileSync("mode.txt","utf8")[0];` +
    `process.stdout.write(m);process.stdout.write(Buffer.alloc(${MAX_CAPTURED_BYTES + 100},"x"));process.stdout.write("\\nend\\n")`;
  const command = `${JSON.stringify(NODE)} -e '${script}'`;
  const lock: VibeCheck = {
    schemaVersion: LOCK_SCHEMA_VERSION, id: "IL-0001", status: "active", utterance: "u", goal: "g", interpretation: "i",
    keep: [{ kind: "output-unchanged", command }], deny: [], change: "c",
    budget: { files: ["mode.txt"], symbols: [], maxFiles: 1, maxLines: 10 },
    accept: [], assumptions: [], createdAt: "2026-09-26T00:00:00.000Z", createdBy: "test",
  };
  const { index } = await buildIndex(root, { persist: false });
  const baseline = captureBaseline(root, lock, index, undefined, { typecheck: false, outputTimeoutMs: 60_000 });
  const same = verifyWithBaseline(root, lock, baseline, "b.json", index, { typecheck: false, outputTimeoutMs: 60_000 });
  assert.equal(same.items[0].verdict, "held");
  fs.writeFileSync(path.join(root, "mode.txt"), "b\n");
  const changed = verifyWithBaseline(root, lock, baseline, "b.json", index, { typecheck: false, outputTimeoutMs: 60_000 });
  assert.equal(changed.items[0].verdict, "violated", "the kept text is identical; only the full hash can tell");
});

test("probe: a missing program is a spawn error, not a timeout", () => {
  const r = runArgvProbe(tmp(), ["cdir-no-such-program"], 5000);
  assert.equal(r.exitCode, null);
  assert.equal(r.timedOut, false);
  assert.match(r.error ?? "", /ENOENT/);
});

test("diagnostics: a compiler the shell cannot find is unavailable — never a violation of the code", () => {
  const { probeDiagnostics } = require("../src/run/diagnostics") as typeof import("../src/run/diagnostics");
  const check = {
    id: "test.missing",
    subject: "typecheck · missing",
    label: "missing --check",
    tool: "missing",
    defaultTimeoutMs: 10_000,
    plan: () => ({ kind: "run" as const, run: { shell: "cdir-no-such-compiler --check" }, how: "cdir-no-such-compiler --check" }),
    parse: () => [],
    isErrorLine: () => false,
  };
  const r = probeDiagnostics(makeGitRepo(), check);
  assert.equal(r.kind, "unavailable", JSON.stringify(r));
  assert.match((r as { reason: string }).reason, /^missing could not run: exit 127/);
  // Found but not executable: 126.
  const dir = makeGitRepo({ notexec: "#!/bin/sh\n" });
  const r2 = probeDiagnostics(dir, { ...check, plan: () => ({ kind: "run" as const, run: { shell: "./notexec" }, how: "./notexec" }) });
  assert.equal(r2.kind, "unavailable", JSON.stringify(r2));
});
