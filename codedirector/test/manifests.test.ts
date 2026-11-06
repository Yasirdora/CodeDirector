/**
 * W7: dependency manifests are found wherever they sit in the project, not
 * only at the root, and never inside an ignored or build folder.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { presentManifests } from "../src/core/manifests";
import { defaultDomains } from "../src/domain/registry";
import { appearedManifests, type Baseline } from "../src/run/baseline";
import { makeGitRepo } from "./helpers";

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

test("manifests: found below the root, tracked or new; never in an ignored or build folder", () => {
  const root = makeGitRepo({
    "package.json": "{}\n",
    "packages/a/package.json": "{}\n",
    "apple/Core/Package.swift": "// swift-tools-version:6.0\n",
    ".gitignore": "node_modules/\n",
  });
  write(root, "node_modules/left-pad/package.json", "{}\n");
  write(root, "apple/Core/.build/checkouts/dep/Package.swift", "// a checkout\n");
  write(root, "tools/Package.swift", "// new, not added yet\n");
  write(root, "src/package.json.bak", "{}\n");
  const domains = defaultDomains();
  assert.deepEqual(presentManifests(root, domains), [
    "apple/Core/Package.swift",
    "package.json",
    "packages/a/package.json",
    "tools/Package.swift",
  ]);

  fs.rmSync(path.join(root, "packages/a/package.json"));
  assert.deepEqual(
    presentManifests(root, domains),
    ["apple/Core/Package.swift", "package.json", "tools/Package.swift"],
    "a deleted manifest is not present",
  );
});

test("manifests: a root below the git root sees only its own folder, by its own paths", () => {
  const top = makeGitRepo({
    "package.json": "{}\n",
    "sub/apple/Core/Package.swift": "// swift-tools-version:6.0\n",
    "sub/src/a.js": "export const a = 1;\n",
  });
  assert.deepEqual(presentManifests(path.join(top, "sub"), defaultDomains()), ["apple/Core/Package.swift"]);
});

test("manifests: outside git only the root is looked at", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-nogit-"));
  write(root, "package.json", "{}\n");
  write(root, "packages/a/package.json", "{}\n");
  assert.deepEqual(presentManifests(root, defaultDomains()), ["package.json"]);
});

test("manifests: against a baseline that looked at the root only, a manifest below it is not new", () => {
  const root = makeGitRepo({ "package.json": "{}\n", "apple/Core/Package.swift": "// swift-tools-version:6.0\n" });
  write(root, "Podfile", "platform :ios, '17.0'\n");
  const domains = defaultDomains();
  const rootOnly = { manifests: { "package.json": "x" } } as unknown as Baseline;
  assert.deepEqual(appearedManifests(root, rootOnly, domains), ["Podfile"]);
  const wholeTree = { manifests: { "package.json": "x" }, manifestScope: "tree" } as unknown as Baseline;
  assert.deepEqual(appearedManifests(root, wholeTree, domains), ["Podfile", "apple/Core/Package.swift"]);
});

test("manifests: a package.json below the root is fingerprinted by its dependencies, like the root's", () => {
  const domains = defaultDomains();
  const one = domains.manifestFingerprint("packages/a/package.json", '{"name":"a","description":"one","dependencies":{"x":"1"}}');
  const two = domains.manifestFingerprint("packages/a/package.json", '{"name":"a","description":"two","dependencies":{"x":"1"}}');
  const more = domains.manifestFingerprint("packages/a/package.json", '{"name":"a","description":"two","dependencies":{"x":"1","y":"2"}}');
  assert.equal(one, two, "a description is not a dependency");
  assert.notEqual(two, more);
});
