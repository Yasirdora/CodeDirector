/**
 * Vibe Check tests: YAML round-trip, draft proposal quality on the demo
 * repo, clause parsing/admission, and lock validation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { VibeCheck, LOCK_SCHEMA_VERSION } from "../src/lock/types";
import { lockFromYaml, lockToYaml, LockParseError } from "../src/lock/yaml";
import {
  draftLock,
  parseKeepClause,
  defendAnchors,
  judgeConfidence,
  isIndexableLanguage,
  languageOf,
  pluralityLanguage,
  LOW_CONFIDENCE_FLAG,
  type AnchorDefense,
} from "../src/lock/draft";
import { resolveAnchorsDetailed } from "../src/core/map";
import { buildGraph } from "../src/core/graph";
import { checkLock } from "../src/lock/check";
import { listLocks, loadLock } from "../src/lock/store";
import { matchPath, validateGlob } from "../src/lock/glob";
import { copyDemoRepo, copyFixture, makeGitRepo } from "./helpers";

/** An AnchorDefense with everything but the fields under test defaulted. */
function defense(over: Partial<AnchorDefense> = {}): AnchorDefense {
  return {
    symbol: "sym",
    file: "src/a.ts",
    token: "tok",
    how: "whole",
    language: "TypeScript",
    line: "sym — src/a.ts",
    ...over,
  };
}

test("anchor defense: every anchor names its file and the word that picked it", async () => {
  const repo = copyDemoRepo();
  const { index } = await buildIndex(repo);
  const resolution = resolveAnchorsDetailed(buildGraph(index), "make the preview feel instant");
  const defended = defendAnchors(resolution.matches);

  assert.equal(defended.length, resolution.anchors.length);
  for (const d of defended) {
    assert.ok(d.file, "a defended anchor names its defining file");
    assert.ok(d.token, "a defended anchor names the token that matched");
    assert.ok(d.line.includes(d.file), "the one-line form carries the file");
    assert.ok(["exact", "whole", "part", "lexical"].includes(d.how));
  }
});

test("anchor defense: fragment-only anchors are low confidence", () => {
  // "flag" inside flagList is exactly how this drafter anchored on the
  // checkpoint module for a lock about anchor defense.
  const verdict = judgeConfidence(
    [
      defense({ symbol: "flagList", token: "flag", how: "part" }),
      defense({ symbol: "flagStr", token: "flag", how: "part" }),
    ],
    { language: "TypeScript" },
  );
  assert.equal(verdict.low, true);
  assert.ok(verdict.reasons.some((r) => r.includes("fragment")));
});

test("anchor defense: whole-name anchors in the repo's own language are trusted", () => {
  const verdict = judgeConfidence(
    [defense({ symbol: "renderExport", token: "renderexport", how: "whole" })],
    { language: "TypeScript" },
  );
  assert.equal(verdict.low, false);
  assert.deepEqual(verdict.reasons, []);
});

test("anchor defense: a repo cdir cannot parse is told so plainly", () => {
  const verdict = judgeConfidence(
    [defense({ symbol: "parseFountain", how: "whole", language: "TypeScript", file: "packages/x.ts" })],
    { language: "Swift" },
  );
  assert.equal(verdict.low, true);
  const reason = verdict.reasons.join(" ");
  assert.ok(reason.includes("cdir indexes no Swift"), "it names the blindness");
  assert.ok(reason.includes("name the files"), "it says what the human must do instead");
  assert.ok(!reason.includes("may not be indexed"), "no false modesty when the answer is none of it");
});

test("anchor defense: a language cdir CAN parse keeps the softer wording", () => {
  const verdict = judgeConfidence(
    [defense({ symbol: "helper", how: "whole", language: "TypeScript", file: "src/a.ts" })],
    { language: "JavaScript" },
  );
  assert.equal(verdict.low, true);
  assert.ok(verdict.reasons.join(" ").includes("may not be indexed"));
});

test("isIndexableLanguage knows what the walker can actually read", () => {
  assert.equal(isIndexableLanguage("TypeScript"), true);
  assert.equal(isIndexableLanguage("JavaScript"), true);
  assert.equal(isIndexableLanguage("Swift"), false);
  assert.equal(isIndexableLanguage("Python"), false);
});

test("anchor defense: a fragment names the string it was really found in", () => {
  // The bug this test exists for: "line" is inside "ImagePipeline.describe"
  // but not inside "describe", and the defence used to claim the latter.
  const [qualified] = defendAnchors([
    {
      symbol: {
        id: "src/p.ts#ImagePipeline.describe",
        name: "describe",
        qualifiedName: "ImagePipeline.describe",
        file: "src/p.ts",
        kind: "method",
        signature: "describe()",
        startLine: 1,
        endLine: 2,
      } as never,
      token: "line",
      how: "part",
    },
  ]);
  assert.ok(
    qualified.line.includes('inside "ImagePipeline.describe"'),
    `defence must quote the qualified name, got: ${qualified.line}`,
  );
  assert.ok(!qualified.line.includes('inside "describe"'));
});

test("anchor defense: anchors outside the repo's language are low confidence", () => {
  const verdict = judgeConfidence(
    [defense({ symbol: "parseFountain", how: "whole", language: "TypeScript", file: "packages/x.ts" })],
    { language: "Swift" },
  );
  assert.equal(verdict.low, true);
  assert.ok(verdict.reasons.some((r) => r.includes("mostly Swift")));
});

test("anchor defense: no anchors is not a low-confidence draft", () => {
  assert.equal(judgeConfidence([], { language: "Swift" }).low, false);
});

test("plurality language: counts tracked files, ignores what it cannot name", () => {
  const repo = makeGitRepo({
    "App/One.swift": "// swift\n",
    "App/Two.swift": "// swift\n",
    "App/Three.swift": "// swift\n",
    "tools/build.ts": "export {};\n",
    "README.md": "# doc\n",
  });
  assert.equal(pluralityLanguage(repo).language, "Swift");
});

test("plurality language: degrades with a named reason outside git", () => {
  const notARepo = copyFixture();
  const result = pluralityLanguage(notARepo);
  assert.equal(result.language, null);
  assert.ok(result.reason && result.reason.length > 0, "it says why, rather than going quiet");
});

test("languageOf names the source it knows and shrugs at the rest", () => {
  assert.equal(languageOf("apple/Surface.swift"), "Swift");
  assert.equal(languageOf("src/lock/draft.ts"), "TypeScript");
  assert.equal(languageOf("README.md"), "other");
  assert.equal(languageOf("Makefile"), "other");
});

test("draft: the low-confidence flag leads the assumptions", async () => {
  const repo = copyDemoRepo();
  const { index } = await buildIndex(repo);
  const result = draftLock(repo, index, "flag the flagged flags", {
    now: "2026-01-01T00:00:00.000Z",
    createdBy: "test",
  });
  if (result.confidence.low) {
    assert.ok(
      result.lock.assumptions[0].text.startsWith(LOW_CONFIDENCE_FLAG),
      "the warning is the first thing a human reads in the draft",
    );
  }
  // Defended either way — the defense is not conditional on doubt.
  if (result.anchorDefense.length > 0) {
    assert.ok(result.lock.assumptions.some((a) => a.text.startsWith("Anchors defended —")));
  }
});

function sampleLock(): VibeCheck {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    id: "IL-0001",
    status: "draft",
    utterance: "make the preview feel instant",
    goal: "input-to-paint under 50ms during drag",
    interpretation: "p95 drag latency < 50ms",
    keep: [
      { kind: "api-unchanged", symbols: ["src/pipeline.ts#ImagePipeline.renderExport"] },
      { kind: "tests-pass", glob: "test/**/*.test.ts" },
      { kind: "output-unchanged", command: "node export-fixtures.js", fixtures: ["fixtures/*.bin"] },
      { kind: "no-new-dependency" },
      { kind: "custom", text: "feels smooth during drag" },
    ],
    deny: ["src/export.ts", "package-lock.json"],
    change: "preview responsiveness during drag only",
    budget: { files: ["src/preview.ts", "src/slider.ts"], symbols: [], maxFiles: 3, maxLines: 200 },
    accept: ["drag latency p95 < 50ms"],
    assumptions: [{ text: "instant = perceptual", source: "user", confirmed: true }],
    createdAt: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  };
}

test("lock YAML round-trip is exact and byte-stable", () => {
  const lock = sampleLock();
  const yaml1 = lockToYaml(lock);
  const parsed = lockFromYaml(yaml1);
  assert.deepEqual(parsed, lock);
  assert.equal(lockToYaml(parsed), yaml1, "re-serialization is byte-stable");
});

test("lock YAML rejects inadmissible clause kinds", () => {
  const lock = sampleLock();
  const bad = lockToYaml(lock).replace('kind: "custom"', "kind: feels-right").replace("kind: custom", "kind: feels-right");
  assert.throws(() => lockFromYaml(bad), LockParseError);
});

test("parseKeepClause parses all v1 kinds and rejects unknown kinds", () => {
  assert.deepEqual(parseKeepClause("api-unchanged:src/a.ts#foo"), {
    kind: "api-unchanged",
    symbols: ["src/a.ts#foo"],
  });
  assert.deepEqual(parseKeepClause("api-unchanged:a#x,b#y"), {
    kind: "api-unchanged",
    symbols: ["a#x", "b#y"],
  });
  assert.deepEqual(parseKeepClause("tests-pass:test/**/*.test.ts"), {
    kind: "tests-pass",
    glob: "test/**/*.test.ts",
  });
  assert.deepEqual(parseKeepClause("output-unchanged:npm run snapshot"), {
    kind: "output-unchanged",
    command: "npm run snapshot",
  });
  assert.deepEqual(parseKeepClause("no-new-dependency"), { kind: "no-new-dependency" });
  assert.deepEqual(parseKeepClause("custom:feels right"), { kind: "custom", text: "feels right" });
  assert.throws(() => parseKeepClause("feels-right:whatever"), /not admissible|unknown KEEP kind/);
});

test("glob matching: exact, directory prefix, *, **", () => {
  assert.ok(matchPath("src/export.ts", "src/export.ts"));
  assert.ok(matchPath("Export", "Export/Encoder.swift"), "bare path acts as directory prefix");
  assert.ok(!matchPath("Export", "ExportX/a.ts"));
  assert.ok(matchPath("src/*.ts", "src/a.ts"));
  assert.ok(!matchPath("src/*.ts", "src/deep/a.ts"));
  assert.ok(matchPath("test/**/*.test.ts", "test/a.test.ts"), "** matches zero segments");
  assert.ok(matchPath("test/**/*.test.ts", "test/unit/a.test.ts"));
  assert.ok(!matchPath("test/**/*.test.ts", "src/a.test.ts"));
  assert.equal(validateGlob("src/**"), null);
  assert.ok(validateGlob("/abs/path"));
  assert.ok(validateGlob("src/../escape"));
  assert.ok(validateGlob(""));
});

test("draft proposes preview-related budget files for a vague UI utterance", async () => {
  const root = copyDemoRepo();
  const { index } = await buildIndex(root);
  const result = draftLock(root, index, "make the preview feel instant", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  assert.equal(result.lock.status, "draft");
  assert.equal(result.lock.utterance, "make the preview feel instant");
  assert.ok(result.anchors.length > 0, "anchors resolved from the utterance");
  assert.ok(
    result.proposedFiles.includes("src/preview.ts"),
    `budget proposes the preview file, got: ${result.proposedFiles.join(", ")}`,
  );
  assert.ok(
    result.proposedFiles.includes("src/pipeline.ts") || result.proposedFiles.includes("src/slider.ts"),
    "budget proposes preview-related files",
  );
  assert.ok(!result.proposedFiles.some((f) => f.includes(".test.")), "no test files in the budget");
  assert.equal(result.lock.budget.maxFiles, result.lock.budget.files.length);

  // persisted as a draft YAML, loadable by id
  const loaded = loadLock(root, result.lock.id);
  assert.ok(loaded);
  assert.equal(loaded!.id, "IL-0001");
  assert.deepEqual(listLocks(root).map((l) => l.id), ["IL-0001"]);

  // a second draft gets the next sequential id
  const second = draftLock(root, index, "speed up export", {
    now: "2026-09-11T00:00:01.000Z",
    createdBy: "test",
  });
  assert.equal(second.lock.id, "IL-0002");
});

test("draft suggests lockfiles/manifests in deny when present", async () => {
  const root = copyDemoRepo();
  const fs = await import("node:fs");
  const path = await import("node:path");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"demo"}\n');
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  const { index } = await buildIndex(root);
  const result = draftLock(root, index, "make the preview feel instant", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  assert.ok(result.suggestedDeny.includes("package-lock.json"));
  assert.ok(result.suggestedDeny.includes("package.json"));
});

test("checkLock catches a bad budget symbol id and an over-limit budget", async () => {
  const root = copyDemoRepo();
  const { index } = await buildIndex(root);
  const lock = sampleLock();
  lock.budget = {
    files: ["src/preview.ts", "src/slider.ts"],
    symbols: ["src/nope.ts#DoesNotExist"],
    maxFiles: 1, // < files.length
    maxLines: 200,
  };
  const result = checkLock(root, lock, index);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("src/nope.ts#DoesNotExist")), "bad symbol id reported");
  assert.ok(result.errors.some((e) => e.includes("maxFiles")), "over-limit budget reported");
});

test("checkLock catches a bad api-unchanged symbol, a missing file, and a bad deny glob", async () => {
  const root = copyDemoRepo();
  const { index } = await buildIndex(root);
  const lock = sampleLock();
  lock.keep = [{ kind: "api-unchanged", symbols: ["src/pipeline.ts#ImagePipeline.noSuchMethod"] }];
  lock.budget = { files: ["src/missing.ts"], symbols: [], maxFiles: 5, maxLines: 100 };
  lock.deny = ["src/../escape"];
  const result = checkLock(root, lock, index);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("noSuchMethod")));
  assert.ok(result.errors.some((e) => e.includes("src/missing.ts")));
  assert.ok(result.errors.some((e) => e.includes("escape")));
});

test("checkLock passes a well-formed lock and flags custom clauses as human-judged", async () => {
  const root = copyDemoRepo();
  const { index } = await buildIndex(root);
  const lock = sampleLock();
  lock.budget = { files: ["src/preview.ts"], symbols: [], maxFiles: 3, maxLines: 200 };
  const result = checkLock(root, lock, index);
  assert.equal(result.ok, true, `errors: ${result.errors.join("; ")}`);
  assert.ok(result.warnings.some((w) => w.includes("human judges")), "custom clause flagged");
  const custom = result.clauses.find((c) => c.clause.kind === "custom");
  assert.equal(custom?.checkability, "custom");
  const api = result.clauses.find((c) => c.clause.kind === "api-unchanged");
  assert.equal(api?.checkability, "now");
  assert.equal(api?.errors.length, 0, "demo-repo symbol resolves");
});

test("draft caps deny suggestions at scale and notes the omission (field-reported on Hono)", async () => {
  // 24 test files across 12 dirs (→ 12 globs) + 2 manifests + demo's own test
  const root = copyDemoRepo();
  const fs = await import("node:fs");
  const path = await import("node:path");
  for (const d of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]) {
    const dir = `src/${d}`;
    for (let i = 0; i < 2; i++) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, `m${i}.test.ts`), `// t${i}\n`);
    }
  }
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n');
  fs.writeFileSync(path.join(root, "package-lock.json"), '{}\n');
  const { index } = await buildIndex(root);
  const result = draftLock(root, index, "make the preview feel instant", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  assert.ok(result.suggestedDeny.length <= 8, `deny list capped, got ${result.suggestedDeny.length}`);
  assert.ok(result.suggestedDeny.includes("package.json"), "manifests kept first");
  assert.ok(
    result.suggestedDeny.some((d) => d.includes("*")),
    `compression emits directory globs: ${result.suggestedDeny.join(", ")}`,
  );
  assert.ok(result.denyOmitted > 0, "omission counted");
  assert.ok(
    result.lock.assumptions.some((a) => a.text.includes("truncated for readability")),
    "omission noted in the lock's assumptions (valid YAML, no giant line)",
  );
  // the written lock stays valid
  const check = checkLock(root, result.lock, index);
  assert.ok(check.ok, `written lock remains valid: ${check.errors.join("; ")}`);
});

test("budget proposal prefers exact anchors; weak anchors abstain (field-reported on Hono)", async () => {
  const root = copyFixture();
  const { index } = await buildIndex(root);

  // (a) utterance naming a specific symbol proposes its defining file
  const named = draftLock(root, index, "make computeTotal handle discounts", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  assert.equal(named.anchorStrength, "name", `token "computeTotal" is a name match, got ${named.anchorStrength}`);
  assert.ok(
    named.lock.budget.files.includes("src/service.ts"),
    `budget proposes the defining file, got: ${named.lock.budget.files.join(", ")}`,
  );

  // (c) generic utterance with no name-bearing token → empty budget + guidance
  const vague = draftLock(root, index, "please tidy up the codebase a bit", {
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  assert.ok(
    vague.anchorStrength === "lexical" || vague.anchorStrength === "none",
    `generic utterance is weak, got ${vague.anchorStrength}`,
  );
  assert.deepEqual(vague.proposedFiles, [], "weak anchors propose NOTHING rather than a wrong budget");
  assert.ok(
    vague.lock.assumptions.some((a) => a.text.includes("budget left empty")),
    "guidance recorded in assumptions",
  );
});
