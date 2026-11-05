/**
 * Incremental index tests. Uses a temp copy of the fixture repo so tests can
 * mutate files freely. Incrementality is asserted through
 * BuildStats.filesParsed (the reparse counter), never through timing.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { PARSER_VERSION } from "../src/core/parser";
import { loadIndex, saveIndex } from "../src/core/store";
import { RepoWalker } from "../src/core/walk";
import { copyFixture, makeGitRepo } from "./helpers";

test("full build parses every file; rebuild parses none", async () => {
  const root = copyFixture();
  const first = await buildIndex(root);
  assert.equal(first.stats.filesTotal, 4);
  assert.equal(first.stats.filesParsed, 4);
  assert.ok(loadIndex(root), "index persisted");

  const second = await buildIndex(root);
  assert.equal(second.stats.filesParsed, 0, "no file reparsed when nothing changed");
  assert.equal(second.stats.filesUnchanged, 4);
});

test("touching one file reparses exactly that file", async () => {
  const root = copyFixture();
  await buildIndex(root);

  const target = path.join(root, "src", "math.ts");
  fs.writeFileSync(target, fs.readFileSync(target, "utf8") + "\nexport const EXTRA = 1;\n");

  const { index, stats } = await buildIndex(root);
  assert.equal(stats.filesParsed, 1, "exactly one file reparsed");
  assert.equal(stats.filesUnchanged, 3);
  const mathSymbols = index.files["src/math.ts"].symbols.map((s) => s.name);
  assert.ok(mathSymbols.includes("EXTRA"), "new symbol picked up");
  assert.ok(mathSymbols.includes("double"), "old symbols retained");
});

test("deleting a file drops it from the index", async () => {
  const root = copyFixture();
  await buildIndex(root);
  fs.rmSync(path.join(root, "src", "main.ts"));
  const { index, stats } = await buildIndex(root);
  assert.equal(stats.filesRemoved, 1);
  assert.ok(!index.files["src/main.ts"]);
});

test("walker honors .gitignore and skips node_modules", async () => {
  const root = copyFixture();
  fs.mkdirSync(path.join(root, "ignored"), { recursive: true });
  fs.writeFileSync(path.join(root, "ignored", "junk.ts"), "export const x = 1;\n");
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");

  const files = new RepoWalker(root).walk();
  assert.ok(!files.some((f) => f.startsWith("ignored/")), ".gitignore honored");
  assert.ok(!files.some((f) => f.startsWith("node_modules/")), "node_modules skipped");
  assert.equal(files.length, 4);
});

test("walker skips Xcode build-product directories", async () => {
  const root = copyFixture();
  for (const dir of ["DerivedData", ".build", ".swiftpm", "Pods", "Carthage"]) {
    fs.mkdirSync(path.join(root, dir, "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "deep", "junk.ts"), "export const x = 1;\n");
  }
  const files = new RepoWalker(root).walk();
  for (const dir of ["DerivedData", ".build", ".swiftpm", "Pods", "Carthage"]) {
    assert.ok(!files.some((f) => f.startsWith(dir + "/")), `${dir} skipped`);
  }
  assert.equal(files.length, 4);
});

test("an index from the previous parser version is rebuilt, not read with a missing references field", async () => {
  const root = makeGitRepo({
    "Sources/App/Model.swift":
      "public struct Model { public func refresh() -> Int { 1 } }\n" +
      "public func makeModel() -> Model { Model() }\n",
  });
  await buildIndex(root);
  const old = loadIndex(root)!;
  const oldFile = old.files["Sources/App/Model.swift"] as unknown as {
    parserVersion: number;
    references?: string[];
  };
  oldFile.parserVersion = PARSER_VERSION - 1;
  delete oldFile.references;
  saveIndex(root, old);
  const { index, stats } = await buildIndex(root);
  assert.equal(stats.filesParsed, 1, "the old entry was reparsed, not trusted");
  const rebuilt = index.files["Sources/App/Model.swift"] as unknown as { references?: string[] };
  assert.ok(rebuilt.references?.includes("Model"), "the new field is present after the rebuild");
});
