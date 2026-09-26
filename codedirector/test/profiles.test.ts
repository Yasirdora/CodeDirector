/**
 * Lock-draft profile tests: the apple preset contents, the generated-project
 * (pbxproj) rule, profile + explicit-flag merge semantics, and the unknown
 * profile error.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { draftLock } from "../src/lock/draft";
import { getProfile, mergeDraftOptions } from "../src/lock/profiles";
import { APPLE_VERIFY_TIMEOUT_MS } from "../src/domains/apple";
import { lockFromYaml } from "../src/lock/yaml";
import { loadLock } from "../src/lock/store";
import { makeGitRepo } from "./helpers";

const CLI = path.join(__dirname, "..", "src", "cli.js");

const APPLE_BASE_DENY = [
  "Pods/**",
  "Carthage/**",
  "Podfile.lock",
  "Package.resolved",
  "Cartfile.resolved",
  "Gemfile.lock",
  "*.p8",
  "*.mobileprovision",
  "*.cer",
  "**/DerivedData/**",
];

test("profile: apple preset denies vendor dirs, lockfiles, signing assets, DerivedData", () => {
  const root = makeGitRepo();
  const profile = getProfile("apple", root)!;
  assert.ok(profile, "apple profile exists");
  assert.deepEqual(profile.deny, APPLE_BASE_DENY);
  assert.deepEqual(profile.keep, [{ kind: "no-new-dependency" }]);
  assert.equal(profile.verifyCommand, undefined, "no Package.swift — no verifyCommand guessed");
  assert.equal(profile.verifyTimeoutMs, undefined);
});

test("profile: Package.swift sets verifyCommand 'swift test' with a 15-minute timeout", () => {
  const root = makeGitRepo({ "Package.swift": "// swift-tools-version:5.9\n" });
  const profile = getProfile("apple", root)!;
  assert.equal(profile.verifyCommand, "swift test");
  assert.equal(profile.verifyTimeoutMs, APPLE_VERIFY_TIMEOUT_MS);
  assert.equal(APPLE_VERIFY_TIMEOUT_MS, 900_000);
});

test("profile: generated Xcode projects (XcodeGen/Tuist) also deny the project bundles", () => {
  const plain = makeGitRepo({ "Package.swift": "// swift-tools-version:5.9\n" });
  assert.ok(!getProfile("apple", plain)!.deny!.some((d) => d.includes("xcodeproj")), "hand-maintained project stays editable");

  const xcodegen = makeGitRepo({ "project.yml": "name: App\n" });
  const tuist = makeGitRepo({ "Project.swift": "import ProjectDescription\n" });
  for (const root of [xcodegen, tuist]) {
    const deny = getProfile("apple", root)!.deny!;
    assert.ok(deny.includes("*.xcodeproj/**"), `generated project denied in ${root}`);
    assert.ok(deny.includes("*.xcworkspace/**"));
  }
});

test("profile: unknown name resolves to null", () => {
  const root = makeGitRepo();
  assert.equal(getProfile("windows", root), null);
});

test("profile: merge — explicit lists ADD to the profile, explicit verifyCommand wins", () => {
  const root = makeGitRepo({ "Package.swift": "// swift-tools-version:5.9\n" });
  const profile = getProfile("apple", root)!;
  const merged = mergeDraftOptions(profile, {
    deny: ["Fastfile"],
    keep: [{ kind: "tests-pass", glob: "Tests/**" }],
    budgetFiles: ["Sources/App/Main.swift"],
    verifyCommand: "xcodebuild test -scheme App",
  });
  assert.deepEqual(merged.deny, [...APPLE_BASE_DENY, "Fastfile"]);
  assert.deepEqual(merged.keep, [{ kind: "no-new-dependency" }, { kind: "tests-pass", glob: "Tests/**" }]);
  assert.deepEqual(merged.budgetFiles, ["Sources/App/Main.swift"]);
  assert.equal(merged.verifyCommand, "xcodebuild test -scheme App", "explicit verifyCommand overrides the profile's");
});

test("profile: drafting with the preset lands in the lock YAML (round-trip)", async () => {
  const root = makeGitRepo({ "Package.swift": "// swift-tools-version:5.9\n" });
  const { index } = await buildIndex(root);
  const profile = getProfile("apple", root)!;
  const result = draftLock(root, index, "add a greeting screen", {
    ...profile,
    now: "2026-09-11T00:00:00.000Z",
    createdBy: "test",
  });
  assert.equal(result.lock.verifyCommand, "swift test");
  assert.equal(result.lock.verifyTimeoutMs, APPLE_VERIFY_TIMEOUT_MS);
  assert.deepEqual(result.lock.keep, [{ kind: "no-new-dependency" }]);
  const loaded = loadLock(root, result.lock.id)!;
  assert.equal(loaded.verifyTimeoutMs, APPLE_VERIFY_TIMEOUT_MS, "verifyTimeoutMs survives the YAML round-trip");
  const raw = fs.readFileSync(result.path, "utf8");
  assert.equal(lockFromYaml(raw).verifyTimeoutMs, APPLE_VERIFY_TIMEOUT_MS);
});

test("profile: CLI rejects an unknown profile naming the available ones", () => {
  const root = makeGitRepo();
  let err: { status: number | null; stderr: string } | null = null;
  try {
    execFileSync(process.execPath, [CLI, "lock", "new", "add a screen", "--profile", "bogus", "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    err = e as { status: number | null; stderr: string };
  }
  assert.ok(err, "unknown profile fails");
  assert.equal(err!.status, 2, "usage error exit code");
  assert.match(err!.stderr, /unknown profile "bogus"/);
  assert.match(err!.stderr, /available: apple/);
});
