/**
 * Scope-enforcement regressions: classification vs the pre-run baseline,
 * not vs current HEAD. These are the holes a git-literate agent used to walk
 * through.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { buildGraph, directCallers } from "../src/core/graph";
import { draftLock } from "../src/lock/draft";
import { loadLock, saveLock } from "../src/lock/store";
import { IntentLock } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { runIsolated } from "../src/run/tree";
import { dependencyFingerprint } from "../src/run/deps";
import { undo } from "../src/checkpoint";
import { git, makeGitRepo } from "./helpers";

const NODE = process.execPath;

async function active(
  files: Record<string, string>,
  customize: (lock: IntentLock) => void,
): Promise<{ root: string; lock: IntentLock }> {
  const root = makeGitRepo(files);
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "probe", { now: "2026-01-01T00:00:00.000Z", createdBy: "t" });
  lock.status = "active";
  customize(lock);
  saveLock(root, lock);
  return { root, lock };
}

test("scope: git mv of a deny path into budget is still DENY", async () => {
  const { root, lock } = await active(
    { "secrets/key.js": "export const SECRET=1;\n", "src/ok.js": "export const ok=1;\n" },
    (l) => {
      l.budget = { files: ["src/ok.js", "src/stolen.js"], symbols: [], maxFiles: 5, maxLines: 400 };
      l.deny = ["secrets/**"];
      l.keep = [];
    },
  );
  const r = await runWithLock(root, lock.id, ["git", "mv", "secrets/key.js", "src/stolen.js"], { stdio: "pipe" });
  assert.equal(r.exitCode, 1);
  assert.ok(
    r.record.violations.some((v) => v.includes("DENY") && v.includes("secrets")),
    r.record.violations.join("; "),
  );
});

test("scope: committing a deny edit does not hide it", async () => {
  const { root, lock } = await active(
    { "src/a.js": "export const a=1;\n", "src/b.js": "export const b=1;\n" },
    (l) => {
      l.budget = { files: ["src/a.js"], symbols: [], maxFiles: 1, maxLines: 400 };
      l.deny = ["src/b.js"];
      l.keep = [];
    },
  );
  const script =
    'const fs=require("fs");const {execFileSync}=require("child_process");' +
    'fs.appendFileSync("src/b.js","// pwned\\n");' +
    'execFileSync("git",["-c","user.name=a","-c","user.email=a@a","add","-A"]);' +
    'execFileSync("git",["-c","user.name=a","-c","user.email=a@a","commit","-qm","sneak"]);';
  const r = await runWithLock(root, lock.id, [NODE, "-e", script], { stdio: "pipe" });
  assert.equal(r.exitCode, 1);
  assert.ok(r.record.violations.some((v) => v.includes("DENY")), r.record.violations.join("; "));
});

test("scope: skip-worktree deny edit is a violation; undo restores it", async () => {
  const { root, lock } = await active(
    { "src/a.js": "export const a=1;\n", "src/secret.js": "export const s=1;\n" },
    (l) => {
      l.budget = { files: ["src/a.js"], symbols: [], maxFiles: 2, maxLines: 400 };
      l.deny = ["src/secret.js"];
      l.keep = [];
    },
  );
  const script =
    'const {execFileSync}=require("child_process");const fs=require("fs");' +
    'execFileSync("git",["update-index","--skip-worktree","src/secret.js"]);' +
    'fs.appendFileSync("src/secret.js","// hidden\\n");fs.appendFileSync("src/a.js","// ok\\n");';
  const r = await runWithLock(root, lock.id, [NODE, "-e", script], { stdio: "pipe" });
  assert.equal(r.exitCode, 1, r.record.violations.join("; "));
  assert.ok(/secret/.test(r.record.violations.join(" ")), r.record.violations.join("; "));
  undo(root);
  assert.equal(fs.readFileSync(path.join(root, "src/secret.js"), "utf8"), "export const s=1;\n");
});

test("scope: pre-existing dirty files are not billed to the command", async () => {
  const { root, lock } = await active(
    { "src/a.js": "export const a=1;\n", "src/b.js": "export const b=1;\n" },
    (l) => {
      l.budget = { files: ["src/a.js"], symbols: [], maxFiles: 1, maxLines: 400 };
      l.deny = [];
      l.keep = [];
    },
  );
  fs.appendFileSync(path.join(root, "src/b.js"), "// already dirty\n");
  const r = await runWithLock(root, lock.id, [NODE, "-e", 'require("fs").appendFileSync("src/a.js","// cmd\\n")'], {
    stdio: "pipe",
  });
  assert.equal(r.exitCode, 0, r.record.violations.join("; "));
  assert.ok(!r.record.changed.some((c) => c.path === "src/b.js"));
});

test("scope: write outside --root is out-of-budget", async () => {
  const tmp = makeGitRepo({ "app/src/a.js": "export const a=1;\n", "other/pwn.js": "export const p=1;\n" });
  const app = path.join(tmp, "app");
  const { index } = await buildIndex(app);
  const { lock } = draftLock(app, index, "probe", { now: "2026-01-01T00:00:00.000Z", createdBy: "t" });
  lock.status = "active";
  lock.budget = { files: ["src/a.js"], symbols: [], maxFiles: 1, maxLines: 400 };
  lock.deny = [];
  lock.keep = [];
  saveLock(app, lock);
  const r = await runWithLock(
    app,
    lock.id,
    [
      NODE,
      "-e",
      'require("fs").appendFileSync("../other/pwn.js","// outside\\n");require("fs").appendFileSync("src/a.js","// ok\\n");',
    ],
    { stdio: "pipe" },
  );
  assert.equal(r.exitCode, 1);
  assert.ok(
    r.record.changed.some((c) => c.path.includes("pwn") && c.class === "out-of-budget"),
    JSON.stringify(r.record.changed),
  );
});

test("scope: output-unchanged probe must not mutate deny files", async () => {
  const { root, lock } = await active(
    { "src/a.js": "export const a=1;\n", "src/ok.js": "export const ok=1;\n" },
    (l) => {
      l.budget = { files: ["src/ok.js"], symbols: [], maxFiles: 2, maxLines: 400 };
      l.deny = ["src/a.js"];
      l.keep = [
        {
          kind: "output-unchanged",
          command: "node -e \"require('fs').writeFileSync('src/a.js','export const a=999;\\n'); console.log('x');\"",
        },
      ];
    },
  );
  const r = await runWithLock(root, lock.id, [NODE, "-e", 'require("fs").appendFileSync("src/ok.js","// cmd\\n")'], {
    stdio: "pipe",
  });
  assert.equal(fs.readFileSync(path.join(root, "src/a.js"), "utf8"), "export const a=1;\n");
  assert.equal(r.exitCode, 0, r.record.violations.join("; "));
});

test("scope: tests-pass cannot sneak a deny write", async () => {
  const { root, lock } = await active(
    {
      "src/a.js": "export const a=1;\n",
      "src/secret.js": "export const s=1;\n",
      "test/a.test.js":
        'import test from "node:test";\nimport fs from "node:fs";\ntest("pwn", () => { fs.appendFileSync("src/secret.js", "// from-test\\n"); });\n',
    },
    (l) => {
      l.budget = { files: ["src/a.js"], symbols: [], maxFiles: 2, maxLines: 400 };
      l.deny = ["src/secret.js"];
      l.keep = [{ kind: "tests-pass", glob: "test/*.test.js" }];
    },
  );
  const r = await runWithLock(root, lock.id, [NODE, "-e", 'require("fs").appendFileSync("src/a.js","// ok\\n")'], {
    stdio: "pipe",
  });
  assert.equal(fs.readFileSync(path.join(root, "src/secret.js"), "utf8"), "export const s=1;\n");
  assert.equal(r.exitCode, 0, r.record.violations.join("; "));
});

test("no-new-dependency: package.json description-only is not a new dep", async () => {
  const { root, lock } = await active(
    {
      "src/a.js": "export const a=1;\n",
      "package.json": JSON.stringify({ name: "x", version: "1.0.0", dependencies: {} }, null, 2) + "\n",
    },
    (l) => {
      l.budget = { files: ["src/a.js", "package.json"], symbols: [], maxFiles: 2, maxLines: 400 };
      l.deny = [];
      l.keep = [{ kind: "no-new-dependency" }];
    },
  );
  const r = await runWithLock(
    root,
    lock.id,
    [
      NODE,
      "-e",
      'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("package.json","utf8")); j.description="hello"; fs.writeFileSync("package.json", JSON.stringify(j,null,2)+"\\n"); fs.appendFileSync("src/a.js","//x\\n");',
    ],
    { stdio: "pipe" },
  );
  assert.equal(r.exitCode, 0, r.record.violations.join("; "));
});

test("utterance is frozen after activate", async () => {
  const { root, lock } = await active({ "src/a.js": "export const a=1;\n" }, (l) => {
    l.budget = { files: ["src/a.js"], symbols: [], maxFiles: 1, maxLines: 400 };
    l.keep = [];
  });
  const dir = path.join(root, ".codedirector/locks");
  const f = fs.readdirSync(dir).find((n) => n.endsWith(".yaml"))!;
  const p = path.join(dir, f);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("probe", "TAMPERED"));
  assert.equal(loadLock(root, lock.id)!.utterance, "probe");
});

test("graph: import { realName as alias } resolves to realName", async () => {
  const root = makeGitRepo({
    "src/lib.js": "export function realName(){return 1}\n",
    "src/use.js": 'import { realName as alias } from "./lib.js";\nexport function caller(){ alias(); }\n',
  });
  const { index } = await buildIndex(root);
  const g = buildGraph(index);
  const callers = directCallers(g, "src/lib.js#realName").map((s) => s.id);
  assert.ok(callers.includes("src/use.js#caller"), `callers=${callers.join(",")}`);
});

test("runIsolated: dirty and untracked BINARY files round-trip byte-identical", () => {
  const root = makeGitRepo({ "src/a.js": "export const a=1;\n" });
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  // tracked binary, committed, then dirtied
  fs.writeFileSync(path.join(root, "tracked.bin"), bytes);
  git(root, ["add", "tracked.bin"]);
  git(root, ["commit", "-qm", "add binary"]);
  const dirty = Buffer.concat([bytes, Buffer.from([0, 255, 128, 10, 13])]);
  fs.writeFileSync(path.join(root, "tracked.bin"), dirty);
  // untracked binary
  fs.writeFileSync(path.join(root, "untracked.bin"), bytes);

  const inside = runIsolated(root, () => {
    // probe mutates both binaries and creates a new file — all must be undone
    fs.writeFileSync(path.join(root, "tracked.bin"), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(root, "untracked.bin"), Buffer.from([4, 5, 6]));
    fs.writeFileSync(path.join(root, "probe-created.tmp"), "x");
    return "ok";
  });
  assert.equal(inside, "ok");
  assert.ok(fs.readFileSync(path.join(root, "tracked.bin")).equals(dirty), "dirty tracked binary restored byte-for-byte");
  assert.ok(fs.readFileSync(path.join(root, "untracked.bin")).equals(bytes), "untracked binary restored byte-for-byte");
  assert.equal(fs.existsSync(path.join(root, "probe-created.tmp")), false, "probe-created file removed");
});

test("runIsolated: clean tracked file modified by the probe is restored", () => {
  const root = makeGitRepo({ "src/a.js": "export const a=1;\n", "src/b.js": "export const b=2;\n" });
  runIsolated(root, () => {
    fs.writeFileSync(path.join(root, "src/b.js"), "export const b=999;\n");
  });
  assert.equal(fs.readFileSync(path.join(root, "src/b.js"), "utf8"), "export const b=2;\n");
});

test("dependencyFingerprint: reordered dependency keys give the same fingerprint", () => {
  const a = JSON.stringify({ name: "x", dependencies: { alpha: "1.0.0", beta: "^2.0.0", gamma: "~3.0.0" } });
  const b = JSON.stringify({ name: "x", dependencies: { gamma: "~3.0.0", alpha: "1.0.0", beta: "^2.0.0" } });
  assert.equal(dependencyFingerprint(a), dependencyFingerprint(b));
  const c = JSON.stringify({ name: "x", dependencies: { alpha: "1.0.0", beta: "^2.0.0", gamma: "~3.0.1" } });
  assert.notEqual(dependencyFingerprint(a), dependencyFingerprint(c), "version change still detected");
});


