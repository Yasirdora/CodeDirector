/**
 * The Node/TypeScript domain: what Code Director knows about JavaScript and
 * TypeScript projects — how their imports resolve, which files are tests,
 * which manifests carry dependencies, and how tsc and `node --test` are run
 * and read. The core runs every check described here.
 */

import type { Domain } from "../../domain/types";
import { dependencyFingerprint } from "./deps";
import { resolveNodeImport } from "./modules";
import { compressTestPaths, isNodeTestFile, nodeTestRunner } from "./tests";
import { tscCheck } from "./tsc";

export const nodeDomain: Domain = {
  id: "node",
  description: "JavaScript/TypeScript: module resolution, test conventions, npm manifests, tsc, node --test",
  graphFacts: {
    resolveImport(fromFile, specifier, hasFile) {
      const target = resolveNodeImport(fromFile, specifier, hasFile);
      return target ? { target, source: "tree-sitter" } : null;
    },
  },
  testMapping: {
    isTestFile: isNodeTestFile,
    compressTestPaths,
  },
  dependencyFacts: {
    manifests: [
      { path: "package.json", fingerprint: dependencyFingerprint },
      { path: "package-lock.json" },
      { path: "yarn.lock" },
      { path: "pnpm-lock.yaml" },
    ],
  },
  checkProviders: {
    diagnostics: [tscCheck],
    testRunner: nodeTestRunner,
    toolchains: [
      { name: "tsc", pattern: /\btsc\b/, languages: ["TypeScript"] },
      { name: "node --test", pattern: /\bnode\s+--test\b/, languages: ["TypeScript", "JavaScript"] },
      { name: "npm/yarn/pnpm", pattern: /\b(npm|yarn|pnpm)\b/, languages: ["TypeScript", "JavaScript"] },
      {
        name: "vitest/jest/mocha",
        pattern: /\b(vitest|jest|mocha)\b/,
        languages: ["TypeScript", "JavaScript"],
      },
    ],
  },
  generatedPathRules: {
    neverSourceDirs: ["node_modules"],
  },
};
