/**
 * The domain boundary (ADR 0001).
 *
 * Three kinds of test live here:
 *  - a synthetic domain ("acme") contributes every capability — graph facts,
 *    test mapping, dependency manifests, a diagnostics check, a test runner,
 *    toolchains, a profile, generated paths, a change classifier — and the
 *    core uses each one without a core file knowing it exists;
 *  - the built-in registry reproduces what the core hard-coded before the
 *    split, so the refactor changed no behaviour;
 *  - the import boundary: the core never reaches into a domain, and a
 *    domain never reaches into execution.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { buildGraph, isTestFile, testFilesFor } from "../src/core/graph";
import { compareProvenance, effectiveEvidence, freshnessOf, FactProvenance, strongestProvenance } from "../src/core/provenance";
import { defaultDomains, DomainRegistry, DomainRegistryError } from "../src/domain/registry";
import { Domain, DiagnosticsCheck, TestRunnerDescription } from "../src/domain/types";
import { checkLock, verifyCoverage } from "../src/lock/check";
import { draftLock } from "../src/lock/draft";
import { describeProfiles, getProfile, PROFILE_NAMES } from "../src/lock/profiles";
import { LOCK_SCHEMA_VERSION, KeepClause, VibeCheck } from "../src/lock/types";
import { captureBaseline } from "../src/run/baseline";
import { verifyWithBaseline } from "../src/verify/verify";
import { DEPENDENCY_MANIFESTS } from "../src";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;

function lockWith(keep: KeepClause[], extra: Partial<VibeCheck> = {}): VibeCheck {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id: "IL-0001",
    status: "active",
    utterance: "domain test",
    goal: "g",
    interpretation: "i",
    keep,
    deny: [],
    change: "c",
    budget: { files: [], symbols: [], maxFiles: 1, maxLines: 100 },
    accept: [],
    assumptions: [],
    createdAt: "2026-09-26T00:00:00.000Z",
    createdBy: "test",
    ...extra,
  };
}

// ---------------------------------------------------------------------
// The synthetic domain

/** Prints every line of diag.txt; exits 1 when there is one. */
const LINT_SCRIPT =
  "const fs=require('fs');const t=fs.existsSync('diag.txt')?fs.readFileSync('diag.txt','utf8').trim():'';" +
  "if(t){console.log(t);process.exit(1)}";

const acmeLint: DiagnosticsCheck = {
  id: "acme.lint",
  subject: "typecheck · acme lint",
  label: "acme lint",
  tool: "acme",
  defaultTimeoutMs: 30_000,
  plan(rootDir) {
    if (!fs.existsSync(path.join(rootDir, "acme.json"))) {
      return { kind: "not-applicable", reason: "no acme.json — acme lint skipped" };
    }
    return { kind: "run", run: { argv: [NODE, "-e", LINT_SCRIPT] }, how: "acme lint ." };
  },
  parse(stdout) {
    const out: Array<{ key: string; line: string }> = [];
    for (const line of stdout.split("\n")) {
      const m = /^(\S+):\d+: error (ACME\d+): (.*)$/.exec(line.trim());
      if (m) out.push({ key: `${m[1]}: ${m[2]}: ${m[3]}`, line: line.trim() });
    }
    return out;
  },
  isErrorLine: (line) => line.includes("error ACME"),
};

/** Runs each *.check.js file; a check file fails by throwing "FAIL <name>". */
const acmeRunner: TestRunnerDescription = {
  id: "acme.check",
  label: "acme check",
  covers: "Acme",
  acceptsFile: (f) => f.endsWith(".check.js"),
  argv: (files) => [
    NODE,
    "-e",
    "for (const f of process.argv.slice(1)) require(require('path').resolve(f))",
    ...files,
  ],
  failures: (output) => [...new Set([...output.matchAll(/FAIL (\w+)/g)].map((m) => m[1]))],
};

function acmeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: "acme",
    description: "a synthetic ecosystem for boundary tests",
    projectFacts: {
      detect: (rootDir) =>
        fs.existsSync(path.join(rootDir, "acme.json"))
          ? [{ kind: "acme-project", path: "acme.json", provenance: { source: "file-system", domain: "acme", evidence: "asserted", freshness: "current" } }]
          : [],
    },
    graphFacts: {
      // "@acme/<name>" names lib/<name>.ts — nothing like Node's resolution.
      resolveImport(_from, specifier, hasFile) {
        const m = /^@acme\/(\w+)$/.exec(specifier);
        if (!m) return null;
        const target = `lib/${m[1]}.ts`;
        return hasFile(target) ? { target, source: "acme-resolver" } : null;
      },
    },
    testMapping: { isTestFile: (f) => f.startsWith("checks/") },
    dependencyFacts: {
      manifests: [
        // Comment lines are not dependencies.
        { path: "acme.lock", fingerprint: (raw) => raw.split("\n").filter((l) => !l.startsWith("#")).join("\n") },
      ],
    },
    checkProviders: {
      diagnostics: [acmeLint],
      testRunner: acmeRunner,
      toolchains: [{ name: "acme", pattern: /\bacme\s+check\b/, languages: ["TypeScript"] }],
    },
    changeClassifiers: [
      {
        id: "acme.cosmetic",
        classify: (c) => [
          {
            category: "cosmetic",
            tag: "whitespace-only",
            detail: c.path,
            provenance: { source: "inferred", domain: "acme", evidence: "asserted", freshness: "current" },
          },
        ],
      },
    ],
    profileRules: [
      {
        name: "acme",
        summary: "denies vendor/, keeps no-new-dependency.",
        denyGeneratedPaths: true,
        defaults: (facts) => ({
          deny: ["vendor/**"],
          keep: [{ kind: "no-new-dependency" }],
          ...(facts.some((f) => f.kind === "acme-project") ? { verifyCommand: "acme check" } : {}),
        }),
      },
    ],
    generatedPathRules: {
      neverSourceDirs: ["generated"],
      generatedByMarker: [{ markers: ["acme.gen"], paths: ["gen/**"], reason: "acme generates gen/" }],
    },
    ...overrides,
  };
}

const acmeOnly = () => new DomainRegistry([acmeDomain()]);

// ---------------------------------------------------------------------
// Registration

test("domains: a domain registers only the capabilities it has", () => {
  const minimal = new DomainRegistry([{ id: "bare", description: "nothing but a name" }]);
  assert.deepEqual(minimal.neverSourceDirs(), []);
  assert.deepEqual(minimal.dependencyManifests(), []);
  assert.deepEqual(minimal.diagnosticsChecks(), []);
  assert.equal(minimal.testRunner(), null);
  assert.deepEqual(minimal.profileNames(), []);
  assert.equal(minimal.isTestFile("src/a.test.ts"), false, "no domain, no test convention");
});

test("domains: the registry refuses ambiguous registrations", () => {
  assert.throws(() => new DomainRegistry([acmeDomain(), acmeDomain()]), DomainRegistryError);
  const twin = acmeDomain({ id: "acme2", checkProviders: { diagnostics: [acmeLint] }, profileRules: [] });
  assert.throws(() => new DomainRegistry([acmeDomain(), twin]), /diagnostics check "acme.lint"/);
  const rival = acmeDomain({ id: "rival", checkProviders: { testRunner: acmeRunner }, profileRules: [] });
  assert.throws(() => new DomainRegistry([acmeDomain(), rival]), /tests-pass runner/);
  const clash = acmeDomain({ id: "clash", checkProviders: {} });
  assert.throws(() => new DomainRegistry([acmeDomain(), clash]), /profile "acme"/);
});

test("domains: change classifiers are registered, and nothing consumes them yet", () => {
  const [classifier] = acmeOnly().changeClassifiers();
  assert.equal(classifier.id, "acme.cosmetic");
  assert.equal(classifier.classify({ path: "a.ts", before: "x", after: "x " })[0].category, "cosmetic");
});

// ---------------------------------------------------------------------
// Graph facts, test mapping, generated paths

test("domains: import resolution and its provenance come from the domain", async () => {
  const root = makeGitRepo({
    "lib/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
    "src/main.ts": 'import { add } from "@acme/math";\nimport { twice } from "./twice";\nexport function run() { return add(1, twice(2)); }\n',
    "src/twice.ts": "export function twice(n: number) { return n * 2; }\nexport function unused() { return 0; }\n",
    "checks/math.ts": 'import { add } from "@acme/math";\nadd(1, 1);\n',
    "generated/big.ts": "export function generatedThing() {}\n",
  });
  const domains = acmeOnly();
  const { index } = await buildIndex(root, { persist: false, domains });
  assert.ok(!Object.keys(index.files).some((f) => f.startsWith("generated/")), "the domain's never-source dir is skipped");

  const graph = buildGraph(index, domains);
  const viaAcme = graph.edges.find((e) => e.toId === "lib/math.ts#add" && e.fromId === "src/main.ts#run");
  assert.ok(viaAcme, "an @acme import resolves through the synthetic domain");
  assert.equal(viaAcme!.resolution, "import");
  assert.deepEqual(viaAcme!.provenance, [
    { source: "acme-resolver", domain: "acme", evidence: "asserted", freshness: "current" },
  ]);
  // Without the Node domain a relative import resolves through nothing;
  // `twice` is still found, but only by the unique-name heuristic.
  const twice = graph.edges.find((e) => e.toId === "src/twice.ts#twice")!;
  assert.equal(twice.resolution, "unique-name");
  assert.equal(twice.provenance[0].source, "inferred");

  assert.equal(isTestFile("checks/math.ts", domains), true);
  assert.equal(isTestFile("src/a.test.ts", domains), false, "Node's convention is not the core's");
  const add = graph.symbols.get("lib/math.ts#add")!;
  assert.deepEqual(testFilesFor(index, add, domains), ["checks/math.ts"]);
  assert.deepEqual(domains.compressTestPaths(["checks/b.ts", "checks/a.ts"]), ["checks/a.ts", "checks/b.ts"],
    "a domain without a compressor gets its test files listed singly");
});

test("domains: without the Node domain, node_modules is just a directory", async () => {
  const root = makeGitRepo({ "node_modules/pkg/index.ts": "export function fromPkg() {}\n", "src/a.ts": "export const a = 1;\n" });
  const bare = new DomainRegistry([]);
  const { index } = await buildIndex(root, { persist: false, domains: bare });
  assert.ok(index.files["node_modules/pkg/index.ts"], "skipping it was the Node domain's fact, not the core's");
  const { index: builtin } = await buildIndex(root, { persist: false });
  assert.equal(builtin.files["node_modules/pkg/index.ts"], undefined);
});

// ---------------------------------------------------------------------
// Checks: described by the domain, executed and judged by the core

test("domains: a synthetic diagnostics check runs differentially through the core", async () => {
  const root = makeGitRepo({
    "acme.json": "{}\n",
    "diag.txt": "src/a.ts:3: error ACME1: old problem\n",
    "src/a.ts": "export const a = 1;\n",
  });
  const domains = acmeOnly();
  const lock = lockWith([]);
  const { index } = await buildIndex(root, { persist: false, domains });
  const baseline = captureBaseline(root, lock, index, undefined, { domains });
  assert.deepEqual(baseline.diagnostics, { "acme.lint": ["src/a.ts: ACME1: old problem"] });

  // The pre-existing error moved lines: not the run's.
  fs.writeFileSync(path.join(root, "diag.txt"), "src/a.ts:9: error ACME1: old problem\n");
  let report = verifyWithBaseline(root, lock, baseline, "b.json", index, { domains });
  let item = report.items.find((i) => i.subject === "typecheck · acme lint")!;
  assert.equal(item.verdict, "held");
  assert.equal(item.evidenceClass, "measured");
  assert.match(item.detail, /all present before the run — none new/);
  assert.equal(item.artifactRef, "acme lint . → exit 1");

  // A new error is the run's.
  fs.appendFileSync(path.join(root, "diag.txt"), "src/a.ts:4: error ACME2: new problem\n");
  report = verifyWithBaseline(root, lock, baseline, "b.json", index, { domains });
  item = report.items.find((i) => i.subject === "typecheck · acme lint")!;
  assert.equal(item.verdict, "violated");
  assert.match(item.detail, /1 new error\(s\) since the baseline: src\/a.ts:4: error ACME2: new problem/);
  assert.ok(report.violations.some((v) => v.startsWith("VERIFY typecheck: acme lint")));

  // Clean output is proven.
  fs.writeFileSync(path.join(root, "diag.txt"), "");
  report = verifyWithBaseline(root, lock, baseline, "b.json", index, { domains });
  item = report.items.find((i) => i.subject === "typecheck · acme lint")!;
  assert.deepEqual([item.verdict, item.evidenceClass, item.detail], ["held", "proven", "acme lint clean"]);

  // The core decides "not applicable" is Unchecked, in the domain's words.
  fs.rmSync(path.join(root, "acme.json"));
  report = verifyWithBaseline(root, lock, baseline, "b.json", index, { domains });
  item = report.items.find((i) => i.subject === "typecheck · acme lint")!;
  assert.deepEqual([item.verdict, item.reason], ["unchecked", "no acme.json — acme lint skipped"]);
  assert.ok(!report.items.some((i) => i.subject.includes("tsc")), "no Node domain, no tsc rung");
});

test("domains: dependency manifests and their fingerprints come from the domain", async () => {
  const root = makeGitRepo({ "acme.lock": "# pinned\ndep-a 1.0\n", "package.json": '{"dependencies":{}}\n' });
  const domains = acmeOnly();
  const lock = lockWith([{ kind: "no-new-dependency" }]);
  const { index } = await buildIndex(root, { persist: false, domains });
  const baseline = captureBaseline(root, lock, index, undefined, { domains, typecheck: false });
  assert.deepEqual(Object.keys(baseline.manifests), ["acme.lock"], "package.json is Node's manifest, not this registry's");

  fs.writeFileSync(path.join(root, "acme.lock"), "# re-pinned by a tool\ndep-a 1.0\n");
  let report = verifyWithBaseline(root, lock, baseline, "b.json", index, { domains, typecheck: false });
  assert.equal(report.items.find((i) => i.subject === "no-new-dependency · acme.lock")!.verdict, "held",
    "the domain's fingerprint ignores what is not a dependency");

  fs.appendFileSync(path.join(root, "acme.lock"), "dep-b 2.0\n");
  report = verifyWithBaseline(root, lock, baseline, "b.json", index, { domains, typecheck: false });
  assert.equal(report.items.find((i) => i.subject === "no-new-dependency · acme.lock")!.verdict, "violated");
});

test("domains: tests-pass runs through the registered runner, executed by the core", async () => {
  const root = makeGitRepo({
    "checks/ok.check.js": "// passes\n",
    "checks/bad.check.js": 'throw new Error("FAIL badcase");\n',
    "checks/readme.md": "not a check\n",
  });
  const domains = acmeOnly();
  const lock = lockWith([
    { kind: "tests-pass", glob: "checks/ok.check.js" },
    { kind: "tests-pass", glob: "checks/*.check.js" },
    { kind: "tests-pass", glob: "checks/*" },
  ]);
  const { index } = await buildIndex(root, { persist: false, domains });
  const report = verifyWithBaseline(root, lock, null, undefined, index, { domains, typecheck: false });
  const [ok, bad, foreign] = report.items;
  assert.deepEqual([ok.verdict, ok.evidenceClass, ok.detail], ["held", "measured", "1 test file(s) pass under acme check"]);
  assert.match(ok.artifactRef!, /^acme check checks\/ok\.check\.js \(1 file\(s\)\) → exit 0$/);
  assert.equal(bad.verdict, "violated");
  assert.match(bad.detail, /: badcase$/, "failing names are read by the domain's parser");
  assert.equal(foreign.verdict, "unchecked");
  assert.match(foreign.reason!, /^acme check cannot run 1 matched file\(s\) \(checks\/readme\.md\) — tests-pass measures Acme suites only/);

  const bare = new DomainRegistry([]);
  const none = verifyWithBaseline(root, lockWith([{ kind: "tests-pass", glob: "checks/*" }]), null, undefined, index, { domains: bare, typecheck: false });
  assert.equal(none.items[0].reason, "no test runner is registered for tests-pass");
});

test("domains: lock check reads toolchains and the runner from the registry", () => {
  const root = makeGitRepo({ "src/a.ts": "export const a = 1;\n" });
  const domains = acmeOnly();
  const lock = lockWith([{ kind: "tests-pass", glob: "checks/**/*.ts" }], {
    verifyCommand: "acme check",
    budget: { files: ["src/a.ts"], symbols: [], maxFiles: 1, maxLines: 100 },
  });
  assert.deepEqual(verifyCoverage(lock, domains).toolchains, ["acme"]);
  assert.deepEqual(verifyCoverage(lock, domains).missing, []);
  assert.deepEqual(verifyCoverage(lock).toolchains, [], "the built-in domains do not know acme");
  const result = checkLock(root, lock, null, domains);
  assert.ok(result.errors.some((e) => e.startsWith("tests-pass runs `acme check`, which cannot run .ts files")), result.errors.join(" | "));
});

// ---------------------------------------------------------------------
// Profiles: the core's mechanism, the domain's preset

test("domains: a profile is the domain's preset merged by the core's mechanism", () => {
  const plain = makeGitRepo({ "src/a.ts": "export const a = 1;\n" });
  const domains = acmeOnly();
  assert.deepEqual(getProfile("acme", plain, domains), { deny: ["vendor/**"], keep: [{ kind: "no-new-dependency" }] });
  const project = makeGitRepo({ "acme.json": "{}\n", "acme.gen": "", "src/a.ts": "export const a = 1;\n" });
  assert.deepEqual(getProfile("acme", project, domains), {
    deny: ["vendor/**", "gen/**"],
    keep: [{ kind: "no-new-dependency" }],
    verifyCommand: "acme check",
  });
  assert.equal(getProfile("apple", plain, domains), null, "apple is the built-in registry's, not this one's");
  assert.equal(describeProfiles(domains), 'Optional draft preset (available: acme). "acme" denies vendor/, keeps no-new-dependency.');
});

test("domains: drafting takes manifests and test conventions from the registry", async () => {
  const root = makeGitRepo({
    "acme.lock": "dep 1\n",
    "package.json": "{}\n",
    "lib/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
    "checks/other.ts": "export const x = 1;\n",
  });
  const domains = acmeOnly();
  const { index } = await buildIndex(root, { persist: false, domains });
  const result = draftLock(root, index, "change add", { now: "2026-09-26T00:00:00.000Z", createdBy: "test" }, domains);
  assert.deepEqual(result.suggestedDeny, ["acme.lock", "checks/other.ts"]);
});

// ---------------------------------------------------------------------
// Provenance

test("provenance: stronger evidence ranks first and weaker evidence is kept", () => {
  const syntax: FactProvenance = { source: "tree-sitter", domain: "core", evidence: "asserted", freshness: "current" };
  const compiler: FactProvenance = { source: "sourcekit", domain: "apple", evidence: "proven", freshness: "current" };
  const ranked = [syntax, compiler].sort(compareProvenance);
  assert.deepEqual(ranked, [compiler, syntax], "ranked, not replaced");
  assert.equal(strongestProvenance([syntax, compiler]), compiler);
});

test("provenance: a fact from a stale revision is not evidence", () => {
  assert.equal(freshnessOf("hash-a", "hash-a"), "current");
  assert.equal(freshnessOf("hash-a", "hash-b"), "stale");
  assert.equal(freshnessOf(undefined, "hash-b"), "current", "derived from the current tree by construction");
  const stale: FactProvenance = { source: "indexstore", domain: "apple", evidence: "proven", freshness: "stale", revision: "hash-a" };
  const syntax: FactProvenance = { source: "tree-sitter", domain: "core", evidence: "asserted", freshness: "current" };
  assert.equal(effectiveEvidence(stale), null);
  assert.equal(strongestProvenance([stale, syntax]), syntax, "current syntax outranks a stale compiler fact");
});

test("provenance: built-in graph edges say they are read from syntax or inferred, never proven", async () => {
  const root = makeGitRepo({
    "src/a.ts": 'import { b } from "./b";\nexport function a() { return b() + local(); }\nfunction local() { return 1; }\n',
    "src/b.ts": "export function b() { return 2; }\n",
    "src/c.ts": "export function c(o: any) { o.onlyHere(); }\n",
    "src/k.ts": "export class K { onlyHere() {} }\n",
  });
  const { index } = await buildIndex(root, { persist: false });
  const graph = buildGraph(index);
  const by = (to: string) => graph.edges.find((e) => e.toId === to)!;
  assert.deepEqual(by("src/b.ts#b").provenance, [{ source: "tree-sitter", domain: "node", evidence: "asserted", freshness: "current" }]);
  assert.deepEqual(by("src/a.ts#local").provenance, [{ source: "tree-sitter", domain: "core", evidence: "asserted", freshness: "current" }]);
  assert.equal(by("src/k.ts#K.onlyHere").provenance[0].source, "inferred");
  assert.ok(graph.edges.every((e) => e.provenance.every((p) => p.evidence === "asserted")));
});

// ---------------------------------------------------------------------
// The built-in registry reproduces the pre-split constants

test("builtin: domains are node then apple, and contribute what the core used to hard-code", () => {
  const d = defaultDomains();
  assert.deepEqual(d.domains.map((x) => x.id), ["node", "apple"]);
  assert.deepEqual(DEPENDENCY_MANIFESTS, [
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "Package.swift", "Package.resolved", "Podfile", "Podfile.lock", "Cartfile", "Cartfile.resolved",
  ]);
  assert.deepEqual(new Set(d.neverSourceDirs()), new Set(["node_modules", "DerivedData", ".build", ".swiftpm", "Pods", "Carthage"]));
  assert.deepEqual(d.diagnosticsChecks().map((c) => c.id), ["node.tsc"]);
  assert.equal(d.testRunner()!.runner.label, "node --test");
  assert.deepEqual(PROFILE_NAMES, ["apple"]);
  assert.equal(
    describeProfiles(),
    'Optional draft preset (available: apple). "apple" denies Pods/Carthage/lockfiles/' +
      "signing assets/DerivedData (plus the generated .xcodeproj/.xcworkspace under XcodeGen or Tuist), " +
      "keeps no-new-dependency, and sets verifyCommand to swift test with a 15-minute timeout when Package.swift exists.",
    "the MCP tool description is unchanged",
  );
});

test("builtin: an old baseline's typecheckErrors field is still read", async () => {
  // Captured before the split: tsc's errors lived at the top level.
  const root = makeGitRepo({ "src/a.ts": "export const a = 1;\n" });
  const { index } = await buildIndex(root, { persist: false });
  const lock = lockWith([]);
  const legacy = { ...captureBaseline(root, lock, index, undefined, { typecheck: false }), typecheckErrors: [] as string[] };
  assert.equal(legacy.diagnostics, undefined);
  const tsc = defaultDomains().diagnosticsChecks()[0];
  assert.equal(tsc.legacyBaselineField, "typecheckErrors");
  // No tsconfig here, so the rung is Unchecked either way; what matters is that it reads without throwing.
  const report = verifyWithBaseline(root, lock, legacy, "b.json", index, {});
  assert.equal(report.items.find((i) => i.source === "typecheck")!.reason, "no tsconfig.json — typecheck rung skipped");
});

// ---------------------------------------------------------------------
// The import boundary

const SRC = path.join(__dirname, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Root-relative ("src/…") module paths a file imports, and bare specifiers as written. */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const specs = [...text.matchAll(/(?:from|import|require\()\s*"([^"]+)"/g)].map((m) => m[1]);
  return specs.map((s) =>
    s.startsWith(".") ? path.relative(path.join(SRC, ".."), path.resolve(path.dirname(file), s)).split(path.sep).join("/") : s,
  );
}

const rel = (f: string) => path.relative(path.join(SRC, ".."), f).split(path.sep).join("/");

test("boundary: the core never imports a domain (only the registry and the public facade do)", () => {
  const allowed = new Map([
    ["src/domain/registry.ts", ["src/domains/builtin"]],
    ["src/index.ts", ["src/domains/node/modules", "src/domains/apple"]],
  ]);
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const r = rel(file);
    if (r.startsWith("src/domains/")) continue;
    for (const imp of importsOf(file)) {
      if (!imp.startsWith("src/domains/")) continue;
      if (!(allowed.get(r) ?? []).includes(imp)) offenders.push(`${r} → ${imp}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("boundary: a domain describes, it never executes — and never imports another domain", () => {
  const execution = ["node:child_process", "child_process", "src/run/probe", "src/run/tree", "src/run/diagnostics", "src/run/run", "src/verify/verify"];
  const offenders: string[] = [];
  for (const file of sourceFiles(path.join(SRC, "domains"))) {
    const r = rel(file);
    const own = r.split("/")[2]; // src/domains/<own>/…
    for (const imp of importsOf(file)) {
      if (execution.includes(imp)) offenders.push(`${r} → ${imp}`);
      const m = /^src\/domains\/([^/]+)/.exec(imp);
      if (m && r !== "src/domains/builtin.ts" && m[1] !== own) offenders.push(`${r} → ${imp}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("boundary: ecosystem names stay out of core code (comments aside)", () => {
  const forbidden = [/tsconfig\.json/, /Package\.swift/, /xcodebuild/, /node --test/, /\bnode_modules\b/, /DerivedData/, /Podfile/, /\.xcodeproj/];
  // Known, named exceptions — each one is a later change, not an oversight.
  const known = new Set([
    // Line counting of an untracked directory skips node_modules; moving it
    // to the registry would also skip Apple build dirs, which changes counts.
    "src/run/classify.ts :: \\bnode_modules\\b",
  ]);
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const r = rel(file);
    if (r.startsWith("src/domains/")) continue;
    const code = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const re of forbidden) {
      if (re.test(code) && !known.has(`${r} :: ${re.source}`)) offenders.push(`${r} :: ${re.source}`);
    }
  }
  assert.deepEqual(offenders, []);
});
