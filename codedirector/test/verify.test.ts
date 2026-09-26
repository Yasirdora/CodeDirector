/**
 * Verification-engine tests: every rung of the ladder — structural (proven),
 * typecheck (proven/unavailable), tests (measured pass/fail/missing),
 * output-unchanged (measured round-trip/violation/no-baseline), and custom
 * (always unchecked). Runs against small temp git repos of plain JS.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { loadLock, saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { VibeCheck, KeepClause } from "../src/lock/types";
import { captureBaseline, saveBaseline, latestBaselinePath, loadBaseline } from "../src/run/baseline";
import { runWithLock } from "../src/run/run";
import { verifyLock, verifyWithBaseline } from "../src/verify/verify";
import { VerificationItem } from "../src/verify/types";
import { buildReport } from "../src/report/report";
import { git, makeGitRepo } from "./helpers";

const NODE = process.execPath;

/**
 * An environment in which no TypeScript compiler can be found: node, npm
 * and npx stay reachable, but not a globally installed tsc (`npm i -g
 * typescript`, common on developer machines) nor one in npx's cache. The
 * "no compiler" case has to establish that itself — it used to assume it,
 * and failed wherever a global tsc exists.
 */
function envWithoutGlobalCompilers(opts: { npx: "linked" | "absent" | "broken" }): NodeJS.ProcessEnv {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-nobin-"));
  const nodeDir = path.dirname(process.execPath);
  // npx is tested three ways, not assumed: the machine's own, none at all
  // (process.execPath can resolve into a Homebrew Cellar), and one that is
  // there but dies loading its own scripts — npm's shell shim reached through
  // a link, as on a Mac whose app runtime keeps npx beside node.
  for (const tool of opts.npx === "linked" ? ["node", "npm", "npx"] : ["node"]) {
    const target = tool === "node" ? process.execPath : path.join(nodeDir, tool);
    if (fs.existsSync(target)) fs.symlinkSync(target, path.join(bin, tool));
  }
  if (opts.npx === "broken") {
    fs.writeFileSync(path.join(bin, "npx"), `#!/bin/sh\nexec node -e 'require("/cdir-test/node_modules/npm/bin/npm-prefix.js")'\n`, { mode: 0o755 });
  }
  return {
    ...process.env,
    PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    npm_config_prefix: fs.mkdtempSync(path.join(os.tmpdir(), "cdir-noprefix-")),
    npm_config_cache: fs.mkdtempSync(path.join(os.tmpdir(), "cdir-nocache-")),
  };
}
const append = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;

const MATH_JS = `export function add(a, b) { return a + b; }\n`;
const RENDER_JS = `import { add } from "./math.js";\nconsole.log(\`sum=\${add(2, 3)}\`);\n`;
const MATH_TEST = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\ntest("add works", () => assert.equal(add(2, 3), 5));\n`;

function fixtureFiles(): Record<string, string> {
  return {
    "src/math.js": MATH_JS,
    "src/render.js": RENDER_JS,
    "test/math.test.js": MATH_TEST,
    "package.json": '{"name":"fixture","type":"module","dependencies":{}}\n',
  };
}

async function setup(keep: KeepClause[], customize?: (lock: VibeCheck) => void): Promise<{ root: string; lock: VibeCheck }> {
  const root = makeGitRepo(fixtureFiles());
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make math faster", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  lock.keep = keep;
  lock.budget = { files: ["src/math.js"], symbols: [], maxFiles: 2, maxLines: 400 };
  lock.change = "math internals only";
  lock.goal = "same behavior, faster";
  customize?.(lock);
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return { root, lock };
}

function find(items: VerificationItem[], kind: string): VerificationItem[] {
  return items.filter((i) => i.clauseKind === kind || i.subject.startsWith(kind));
}

test("verify: api-unchanged held is proven with a baseline artifact reference", async () => {
  const { root, lock } = await setup([{ kind: "api-unchanged", symbols: ["src/math.js#add"] }]);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// faster\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0);
  const item = find(outcome.record.verification!.items, "api-unchanged")[0];
  assert.equal(item.verdict, "held");
  assert.equal(item.evidenceClass, "proven");
  assert.ok(item.artifactRef?.includes("#signatures[src/math.js#add]"), `artifactRef: ${item.artifactRef}`);
});

test("verify: api-unchanged signature change is a proven violation", async () => {
  const { root, lock } = await setup([{ kind: "api-unchanged", symbols: ["src/math.js#add"] }]);
  const breakSig =
    'const fs=require("fs");fs.writeFileSync("src/math.js",fs.readFileSync("src/math.js","utf8").replace("add(a, b)","add(a, b, c)"))';
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", breakSig], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 1);
  const item = find(outcome.record.verification!.items, "api-unchanged")[0];
  assert.equal(item.verdict, "violated");
  assert.equal(item.evidenceClass, "proven");
  assert.ok(outcome.record.violations.some((v) => v.includes("KEEP api-unchanged")));
  assert.equal(loadLock(root, lock.id)!.status, "failed", "lock status updated to failed");
});

test("verify: tests-pass is measured — pass and fail", async () => {
  const { root, lock } = await setup([{ kind: "tests-pass", glob: "test/*.test.js" }]);

  const pass = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(pass.exitCode, 0);
  const passItem = find(pass.record.verification!.items, "tests-pass")[0];
  assert.equal(passItem.verdict, "held");
  assert.equal(passItem.evidenceClass, "measured");
  assert.ok(passItem.artifactRef?.includes("node --test"), `artifactRef: ${passItem.artifactRef}`);

  const breakBehavior =
    'const fs=require("fs");fs.writeFileSync("src/math.js",fs.readFileSync("src/math.js","utf8").replace("return a + b","return a - b"))';
  const fail = await runWithLock(root, lock.id, [NODE, "-e", breakBehavior], { stdio: "pipe" });
  assert.equal(fail.exitCode, 1);
  const failItem = find(fail.record.verification!.items, "tests-pass")[0];
  assert.equal(failItem.verdict, "violated");
  assert.equal(failItem.evidenceClass, "measured");
  assert.ok(failItem.detail.includes("add works"), `failing test named: ${failItem.detail}`);
});

test("verify: tests-pass with an empty glob is a violation, not a silent pass", async () => {
  const { root, lock } = await setup([{ kind: "tests-pass", glob: "test/**/*.spec.js" }]);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 1, "empty tests-pass glob fails closed");
  const item = find(outcome.record.verification!.items, "tests-pass")[0];
  assert.equal(item.verdict, "violated");
  assert.ok(item.detail.includes("matched no test files"), `detail: ${item.detail}`);
});

test("verify: a tests-pass glob that reaches a Swift file is unchecked with the reason, not failing", async () => {
  // Reproduced on 0.4.5: a passing Swift test file was reported "tests
  // failing (exit 1)" — node --test ran it as a JavaScript file.
  const { root, lock } = await setup([{ kind: "tests-pass", glob: "Tests/**" }]);
  fs.mkdirSync(path.join(root, "Tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "Tests/AppTests.swift"),
    "import XCTest\nfinal class AppTests: XCTestCase { func testN() { XCTAssertEqual(1, 1) } }\n",
  );
  git(root, ["add", "Tests"]);
  git(root, ["commit", "-qm", "swift tests"]);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  const item = find(outcome.record.verification!.items, "tests-pass")[0];
  assert.equal(item.verdict, "unchecked");
  assert.match(item.reason ?? "", /node --test cannot run 1 matched file\(s\) \(Tests\/AppTests\.swift\)/);
});

test("verify: output-unchanged round-trips and detects change", async () => {
  const { root, lock } = await setup([{ kind: "output-unchanged", command: "node src/render.js" }]);

  const same = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(same.exitCode, 0);
  const sameItem = find(same.record.verification!.items, "output-unchanged")[0];
  assert.equal(sameItem.verdict, "held");
  assert.equal(sameItem.evidenceClass, "measured");

  const changeOutput =
    'const fs=require("fs");fs.writeFileSync("src/render.js",fs.readFileSync("src/render.js","utf8").replace("sum=","total="));' +
    append("src/math.js", "// in-budget\n");
  const changed = await runWithLock(root, lock.id, [NODE, "-e", changeOutput], {
    stdio: "pipe",
    allowExpand: true, // src/render.js is out of budget; accept scope to isolate the KEEP check
  });
  assert.equal(changed.exitCode, 1);
  const changedItem = find(changed.record.verification!.items, "output-unchanged")[0];
  assert.equal(changedItem.verdict, "violated");
  assert.equal(changedItem.evidenceClass, "measured");
  assert.ok(changedItem.detail.includes("output changed"), `detail: ${changedItem.detail}`);
});

test("verify: output-unchanged without a baseline capture is unchecked, not held", async () => {
  const root = makeGitRepo(fixtureFiles());
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make math faster", { now: "2026-09-11T00:00:00.000Z", createdBy: "test" });
  lock.keep = [{ kind: "output-unchanged", command: "node src/render.js" }];
  lock.budget = { files: ["src/math.js"], symbols: [], maxFiles: 2, maxLines: 400 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);

  // Baseline captured BEFORE the clause is added (simulates a lock edited
  // after the run started): no outputs entry for the command.
  const baseline = captureBaseline(root, { ...lock, keep: [] }, index);
  saveBaseline(root, baseline);

  const report = await verifyLock(root, lock.id);
  const item = find(report.items, "output-unchanged")[0];
  assert.equal(item.verdict, "unchecked");
  assert.ok(item.reason?.includes("no pre-change baseline"), `reason: ${item.reason}`);
  assert.equal(report.violations.length, 0);
});

test("verify: no-new-dependency flags a Podfile.lock change (Apple manifests)", async () => {
  const root = makeGitRepo({
    ...fixtureFiles(),
    Podfile: "platform :ios, '17.0'\n",
    "Podfile.lock": "PODS:\n  - Alamofire (5.9.0)\n",
  });
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make math faster", { now: "2026-09-11T00:00:00.000Z", createdBy: "test" });
  lock.keep = [{ kind: "no-new-dependency" }];
  lock.budget = { files: ["src/math.js"], symbols: [], maxFiles: 2, maxLines: 400 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);

  const change =
    append("src/math.js", "// ok\n") +
    ';require("fs").appendFileSync("Podfile.lock","  - SnapKit (5.7.0)\\n")';
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", change], { stdio: "pipe", allowExpand: true });
  assert.equal(outcome.exitCode, 1);
  const item = outcome.record.verification!.items.find((i) => i.subject === "no-new-dependency · Podfile.lock");
  assert.ok(item, "Podfile.lock tracked as a dependency manifest");
  assert.equal(item!.verdict, "violated");
  assert.equal(item!.evidenceClass, "proven");
  assert.ok(item!.detail.includes("Podfile.lock changed"), `detail: ${item!.detail}`);
});

test("verify: custom clauses are always unchecked — human judges", async () => {
  const { root, lock } = await setup([{ kind: "custom", text: "still feels snappy" }]);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0);
  const item = find(outcome.record.verification!.items, "custom")[0];
  assert.equal(item.verdict, "unchecked");
  assert.ok(item.reason?.includes("human judges"));
  const kr = outcome.record.keepResults.find((k) => k.kind === "custom");
  assert.equal(kr?.status, "custom");
});

test("verify: lock-level verifyCommand is measured", async () => {
  const { root, lock } = await setup([], (l) => {
    l.verifyCommand = "node --test test/math.test.js";
  });
  const pass = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(pass.exitCode, 0);
  const item = pass.record.verification!.items.find((i) => i.source === "verify-command");
  assert.equal(item?.verdict, "held");
  assert.equal(item?.evidenceClass, "measured");

  const failLock = { ...lock, verifyCommand: "node -e \"process.exit(2)\"" };
  saveLock(root, { ...failLock, status: "active" });
  sealLock(root, { ...failLock, status: "active" });
  const fail = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// more\n")], { stdio: "pipe" });
  assert.equal(fail.exitCode, 1);
  assert.ok(fail.record.violations.some((v) => v.includes("VERIFY verify-command")), `violations: ${fail.record.violations.join("; ")}`);
});

test("verify: what a verifyCommand changes is put back — the report names the files and where its versions are", async () => {
  const write = 'const fs=require("fs");fs.writeFileSync("notes.md","written during the check\\n");fs.writeFileSync("out.log","log\\n")';
  const { root, lock } = await setup([{ kind: "tests-pass", glob: "test/writes.test.js" }], (l) => {
    l.verifyCommand = `${JSON.stringify(NODE)} -e ${JSON.stringify(write)}`;
  });
  fs.writeFileSync(path.join(root, "notes.md"), "mine\n"); // someone's file, not part of the change
  // A test that leaves a file behind.
  fs.writeFileSync(path.join(root, "test/writes.test.js"), 'import test from "node:test";\nimport fs from "node:fs";\ntest("writes", () => fs.writeFileSync("from-test.txt", "x"));\n');
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.record.violations));
  assert.equal(fs.readFileSync(path.join(root, "notes.md"), "utf8"), "mine\n");
  assert.equal(fs.existsSync(path.join(root, "out.log")), false);
  assert.equal(fs.existsSync(path.join(root, "from-test.txt")), false);
  const putBack = outcome.record.verification!.putBack!;
  assert.deepEqual(
    putBack.map((p) => [p.probe, p.restored.join(","), p.removed.join(",")]),
    [
      ["tests-pass · test/writes.test.js", "", "from-test.txt"],
      [`verifyCommand · ${lock.verifyCommand}`, "notes.md", "out.log"],
    ],
  );
  assert.equal(fs.readFileSync(path.join(root, putBack[1].keptIn!, "notes.md"), "utf8"), "written during the check\n");

  const report = await buildReport(root, lock.id, { verification: outcome.record.verification, run: outcome.record });
  const finding = report.findings.find((f) => f.text.startsWith("verifyCommand"));
  assert.equal(
    finding?.text,
    `verifyCommand · ${lock.verifyCommand} changed 1 file(s), put back as they were: notes.md; it added 1 file(s), removed: out.log. ` +
      `The versions it left are in ${putBack[1].keptIn}/ — if another session edited these files during the check, its work is there.`,
  );
  assert.equal(report.verdict, "verified", "putting back is reported, not a failure");
});

test("verify: every probe that changes the tree is named — before the change and after it", async () => {
  // The typecheck writes a build-info file (incremental), and the output command writes out.txt:
  // each time either runs, the file is removed again and named.
  const codedirModules = path.join(__dirname, "..", "..", "node_modules");
  const root = makeGitRepo({
    "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true,"incremental":true,"tsBuildInfoFile":"types.tsbuildinfo"},"include":["src"]}\n',
    "src/ok.ts": "export const x: number = 1;\n",
  });
  fs.symlinkSync(codedirModules, path.join(root, "node_modules"), "dir");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "link node_modules"]);
  const cmd = `${JSON.stringify(NODE)} -e ${JSON.stringify('require("fs").writeFileSync("out.txt","x");console.log("same")')}`;
  const { lock } = draftLock(root, (await buildIndex(root)).index, "tidy types", { now: "2026-09-25T00:00:00.000Z", createdBy: "test" });
  lock.keep = [{ kind: "output-unchanged", command: cmd }];
  lock.budget = { files: ["src/ok.ts"], symbols: [], maxFiles: 1, maxLines: 100 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);

  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/ok.ts", "export const y: number = 2;\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.record.violations));
  const named = outcome.record.verification!.putBack!.map((p) => [p.probe, p.removed.join(",")]);
  assert.deepEqual(named, [
    [`baseline · output-unchanged · ${cmd}`, "out.txt"],
    ["baseline · typecheck · tsc --noEmit", "types.tsbuildinfo"],
    ["typecheck · tsc --noEmit", "types.tsbuildinfo"],
    [`output-unchanged · ${cmd}`, "out.txt"],
  ]);
  assert.equal(fs.existsSync(path.join(root, "out.txt")), false);
  assert.equal(fs.existsSync(path.join(root, "types.tsbuildinfo")), false);
});

test("verify: verifyTimeoutMs precedence — lock field applies, CLI/API override wins", async () => {
  // verifyCommand sleeps 2s; the lock's 100ms timeout must kill it...
  const { root, lock } = await setup([], (l) => {
    l.verifyCommand = `${JSON.stringify(NODE)} -e "setTimeout(()=>{},2000)"`;
    l.verifyTimeoutMs = 100;
  });
  const timed = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  const timedItem = timed.record.verification!.items.find((i) => i.source === "verify-command");
  assert.equal(timedItem?.verdict, "unchecked");
  assert.ok(timedItem?.reason?.includes("timed out after 100ms"), `reason: ${timedItem?.reason}`);

  // ...and an explicit testTimeoutMs overrides the lock field, letting it pass.
  saveLock(root, { ...lock, status: "active" });
  sealLock(root, { ...lock, status: "active" });
  const overridden = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// more\n")], {
    stdio: "pipe",
    verifyOptions: { testTimeoutMs: 10_000 },
  });
  const heldItem = overridden.record.verification!.items.find((i) => i.source === "verify-command");
  assert.equal(heldItem?.verdict, "held", `detail: ${heldItem?.detail}`);
});

test("verify: explicit testTimeoutMs applies when the lock has no verifyTimeoutMs", async () => {
  const { root, lock } = await setup([], (l) => {
    l.verifyCommand = `${JSON.stringify(NODE)} -e "setTimeout(()=>{},2000)"`;
  });
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], {
    stdio: "pipe",
    verifyOptions: { testTimeoutMs: 100 },
  });
  const item = outcome.record.verification!.items.find((i) => i.source === "verify-command");
  assert.ok(item?.reason?.includes("timed out after 100ms"), "explicit override applies, reason names the value");
});

test("verify: typecheck proven-clean with a local compiler, unchecked without one", async () => {
  // Repo WITH a compiler: symlink the codedirector node_modules in.
  // (__dirname is dist/test once compiled — up two levels to the package root.)
  const codedirModules = path.join(__dirname, "..", "..", "node_modules");
  const root = makeGitRepo({
    "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src"]}\n',
    "src/ok.ts": "export const x: number = 1;\n",
  });
  fs.symlinkSync(codedirModules, path.join(root, "node_modules"), "dir");
  // commit the symlink so the classifier does not see it as an untracked change
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "link node_modules"]);
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "tidy types", { now: "2026-09-11T00:00:00.000Z", createdBy: "test" });
  lock.budget = { files: ["src/ok.ts"], symbols: [], maxFiles: 1, maxLines: 100 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);

  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/ok.ts", "export const y: number = 2;\n")], { stdio: "pipe" });
  assert.equal(
    outcome.exitCode,
    0,
    `violations: ${JSON.stringify(outcome.record.violations)} · items: ` +
      JSON.stringify(outcome.record.verification?.items?.map((i) => [i.subject, i.verdict, i.detail])) +
      ` · changed: ${JSON.stringify(outcome.record.changed)}`,
  );
  const tc = outcome.record.verification!.items.find((i) => i.source === "typecheck");
  assert.ok(tc, "typecheck item present (tsconfig exists)");
  assert.equal(tc!.verdict, "held");
  assert.equal(tc!.evidenceClass, "proven");

  // Type error → measured violation.
  const broken = await runWithLock(root, lock.id, [NODE, "-e", append("src/ok.ts", 'const z: number = "nope";\n')], { stdio: "pipe" });
  assert.equal(broken.exitCode, 1);
  const tc2 = broken.record.verification!.items.find((i) => i.source === "typecheck");
  assert.equal(tc2!.verdict, "violated");
  assert.equal(tc2!.evidenceClass, "measured");
  assert.ok(broken.record.violations.some((v) => v.includes("VERIFY typecheck")));

  // Repo with tsconfig but NO compiler → unchecked with a named reason,
  // whether or not npx is there to look for one.
  for (const npx of ["linked", "absent", "broken"] as const) {
    const root2 = makeGitRepo({
      "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["src"]}\n',
      "src/ok.ts": "export const x: number = 1;\n",
    });
    const { index: index2 } = await buildIndex(root2);
    const d2 = draftLock(root2, index2, "tidy types", { now: "2026-09-11T00:00:00.000Z", createdBy: "test" });
    d2.lock.budget = { files: ["src/ok.ts"], symbols: [], maxFiles: 1, maxLines: 100 };
    d2.lock.status = "active";
    saveLock(root2, d2.lock);
    sealLock(root2, d2.lock);
    const outcome2 = await runWithLock(root2, d2.lock.id, [NODE, "-e", append("src/ok.ts", "// ok\n")], {
      stdio: "pipe",
      verifyOptions: { env: envWithoutGlobalCompilers({ npx }) },
    });
    const tc3 = outcome2.record.verification!.items.find((i) => i.source === "typecheck");
    assert.ok(tc3, "typecheck item present");
    assert.equal(tc3!.verdict, "unchecked", `npx ${npx}: ${tc3!.detail}`);
    assert.ok(tc3!.reason!.length > 0, "unavailability reason named");
  }
});

test("verify: no tsconfig surfaces typecheck as Unchecked, not omitted", async () => {
  const { root, lock } = await setup([]);
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  const tc = outcome.record.verification!.items.find((i) => i.source === "typecheck");
  assert.ok(tc, "typecheck item present");
  assert.equal(tc!.verdict, "unchecked");
  assert.ok(tc!.reason?.includes("no tsconfig.json"));
});

test("verify: standalone verifyLock uses the latest baseline", async () => {
  const { root, lock } = await setup([{ kind: "api-unchanged", symbols: ["src/math.js#add"] }]);
  await runWithLock(root, lock.id, [NODE, "-e", append("src/math.js", "// ok\n")], { stdio: "pipe" });
  const p = latestBaselinePath(root, lock.id);
  assert.ok(p, "baseline exists after run");
  const baseline = loadBaseline(p!);
  assert.ok(baseline.signatures["src/math.js#add"], "signature pinned in baseline");

  const report = await verifyLock(root, lock.id);
  const item = find(report.items, "api-unchanged")[0];
  assert.equal(item.verdict, "held");
  assert.equal(report.baselinePath !== undefined, true);
});

test("verify: standalone verifyLock with NO baseline marks structural checks unchecked", async () => {
  const root = makeGitRepo(fixtureFiles());
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "make math faster", { now: "2026-09-11T00:00:00.000Z", createdBy: "test" });
  lock.keep = [
    { kind: "api-unchanged", symbols: ["src/math.js#add"] },
    { kind: "no-new-dependency" },
    { kind: "tests-pass", glob: "test/*.test.js" },
  ];
  lock.budget = { files: ["src/math.js"], symbols: [], maxFiles: 2, maxLines: 400 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);

  const { index: indexNow } = await buildIndex(root);
  const report = verifyWithBaseline(root, lock, null, undefined, indexNow);
  assert.equal(find(report.items, "api-unchanged")[0].verdict, "unchecked");
  assert.equal(find(report.items, "no-new-dependency")[0].verdict, "unchecked");
  // tests are self-contained — they run even without a baseline
  assert.equal(find(report.items, "tests-pass")[0].verdict, "held");
  // and the run record was never written, so git stays clean for classify
  git(root, ["status", "--porcelain"]);
});

test("verify: a command that edits the baseline invalidates the run (tamper detection)", async () => {
  const { root, lock } = await setup([{ kind: "api-unchanged", symbols: ["src/math.js#add"] }]);
  const tamper =
    'const fs=require("fs");for(const f of fs.readdirSync(".codedirector/baselines"))fs.appendFileSync(".codedirector/baselines/"+f,"tampered");' +
    append("src/math.js", "// ok\n");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", tamper], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 1, "tampered baseline fails the run");
  assert.ok(
    outcome.record.violations.some((v) => v.includes("baseline modified during execution")),
    `violations: ${outcome.record.violations.join("; ")}`,
  );
  const item = find(outcome.record.verification!.items, "api-unchanged")[0];
  assert.equal(item.verdict, "unchecked", "baseline-dependent check no longer trusts the baseline");
  assert.ok(item.reason?.includes("baseline modified during execution"), `reason: ${item.reason}`);
  assert.equal(outcome.record.verification!.baselineTampered, true);
  assert.ok(outcome.record.baselineSha256, "capture-time hash recorded in the run record");
});

/** A committed TypeScript project with a local compiler, and an active, sealed lock over `budget`. */
async function tsProject(files: Record<string, string>, budget: string[]): Promise<{ root: string; lock: VibeCheck }> {
  const codedirModules = path.join(__dirname, "..", "..", "node_modules");
  const root = makeGitRepo({
    "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src"]}\n',
    ...files,
  });
  fs.symlinkSync(codedirModules, path.join(root, "node_modules"), "dir");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "link node_modules"]);
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "tidy", { now: "2026-09-11T00:00:00.000Z", createdBy: "test" });
  lock.budget = { files: budget, symbols: [], maxFiles: budget.length, maxLines: 100 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return { root, lock };
}

test("typecheck: another session's uncommitted type error does not fail a run that did not cause it", async () => {
  // Field case: eDraft IL-0090 — a Swift-only run failed on a half-written
  // SvelteKit route another session was writing. Reproduced on 0.4.5.
  const { root, lock } = await tsProject(
    { "src/other.ts": "export const n: number = 1;\n", "Sources/App.swift": "struct App {}\n" },
    ["Sources/App.swift"],
  );
  fs.writeFileSync(path.join(root, "src/other.ts"), 'export const n: number = "one";\n');
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("Sources/App.swift", "// x\n")], {
    stdio: "pipe",
  });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  const tc = outcome.record.verification!.items.find((i) => i.source === "typecheck")!;
  assert.equal(tc.verdict, "held");
  assert.equal(tc.evidenceClass, "measured", "an error exists, so this is not proven-clean");
  assert.match(tc.detail!, /1 error\(s\), all present before the run — none new/);
});

test("typecheck: a committed type error is not new; an error the run adds still fails, named alone", async () => {
  const { root, lock } = await tsProject(
    { "src/old.ts": 'export const n: number = "one";\n', "src/ok.ts": "export const x: number = 1;\n" },
    ["src/ok.ts"],
  );
  const clean = await runWithLock(root, lock.id, [NODE, "-e", append("src/ok.ts", "export const y: number = 2;\n")], {
    stdio: "pipe",
  });
  assert.equal(clean.exitCode, 0, clean.record.violations.join("; "));
  const broken = await runWithLock(root, lock.id, [NODE, "-e", append("src/ok.ts", 'export const z: number = "nope";\n')], {
    stdio: "pipe",
  });
  assert.equal(broken.exitCode, 1);
  const v = broken.record.violations.find((x) => x.startsWith("VERIFY typecheck"))!;
  assert.match(v, /1 new error\(s\) since the baseline: src\/ok\.ts\(\d+,\d+\)/);
  assert.ok(!v.includes("src/old.ts"), `the old error is not blamed: ${v}`);
});

test("typecheck: moving a pre-existing error down its file does not make it new", async () => {
  const { root, lock } = await tsProject({ "src/ok.ts": 'export const n: number = "one";\n' }, ["src/ok.ts"]);
  const prepend = `const f="src/ok.ts";const fs=require("fs");fs.writeFileSync(f,"// a\\n// b\\n"+fs.readFileSync(f,"utf8"))`;
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", prepend], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
});

test("typecheck: a run that breaks a caller it never touched is caught", async () => {
  // Why the rung diffs before/after instead of looking only at the files the
  // run changed: a changed signature surfaces as an error somewhere else.
  const { root, lock } = await tsProject(
    {
      "src/old.ts": 'export const n: number = "one";\n',
      "src/lib.ts": "export function f(): number { return 1; }\n",
      "src/use.ts": 'import { f } from "./lib";\nexport const k: number = f();\n',
    },
    ["src/lib.ts"],
  );
  const retype = `require("fs").writeFileSync("src/lib.ts","export function f(): string { return \\"1\\"; }\\n")`;
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", retype], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 1);
  const v = outcome.record.violations.find((x) => x.startsWith("VERIFY typecheck"))!;
  assert.match(v, /1 new error\(s\) since the baseline: src\/use\.ts/);
});
