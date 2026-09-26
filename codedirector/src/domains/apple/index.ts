/**
 * The Apple domain: what Code Director knows about Swift and Apple-platform
 * projects today. Facts only — build products the index skips, the
 * manifests that carry dependencies, what `swift` and `xcodebuild` reach,
 * which project files a generator owns, and the `apple` draft profile.
 *
 * Nothing here executes anything (ADR 0001). Swift compiler diagnostics,
 * the Xcode project model and SourceKit facts arrive as further
 * capabilities of this domain, and are run by the core like any other.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { KeepClause } from "../../lock/types";
import type { Domain, ProjectFact } from "../../domain/types";

/** Apple test suites (xcodebuild, swift test) need minutes, not the 60s default. */
export const APPLE_VERIFY_TIMEOUT_MS = 900_000;

/** Fact kind: a SwiftPM package manifest at the project root. */
export const SWIFTPM_PACKAGE = "swiftpm-package";

const APPLE_DENY = [
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

function detect(rootDir: string): ProjectFact[] {
  const facts: ProjectFact[] = [];
  if (fs.existsSync(path.join(rootDir, "Package.swift"))) {
    facts.push({
      kind: SWIFTPM_PACKAGE,
      path: "Package.swift",
      provenance: { source: "file-system", domain: "apple", evidence: "asserted", freshness: "current" },
    });
  }
  return facts;
}

export const appleDomain: Domain = {
  id: "apple",
  description: "Swift/Apple platforms: build products, SwiftPM/CocoaPods/Carthage manifests, swift/xcodebuild, generated Xcode projects",
  projectFacts: { detect },
  dependencyFacts: {
    manifests: [
      { path: "Package.swift" },
      { path: "Package.resolved" },
      { path: "Podfile" },
      { path: "Podfile.lock" },
      { path: "Cartfile" },
      { path: "Cartfile.resolved" },
    ],
  },
  checkProviders: {
    toolchains: [
      { name: "swift", pattern: /\bswift\s+(test|build|run)\b/, languages: ["Swift"] },
      {
        name: "xcodebuild",
        pattern: /\bxcodebuild\b/,
        languages: ["Swift", "Objective-C", "Objective-C++"],
      },
    ],
  },
  generatedPathRules: {
    // Build products — routinely gigabytes, never source.
    neverSourceDirs: ["DerivedData", ".build", ".swiftpm", "Pods", "Carthage"],
    generatedByMarker: [
      {
        // XcodeGen (project.yml) and Tuist (Project.swift) generate the Xcode project.
        markers: ["project.yml", "Project.swift"],
        paths: ["*.xcodeproj/**", "*.xcworkspace/**"],
        reason: "the Xcode project is generated (XcodeGen or Tuist) — never hand-edited",
      },
    ],
  },
  profileRules: [
    {
      name: "apple",
      summary:
        "denies Pods/Carthage/lockfiles/signing assets/DerivedData (plus the generated .xcodeproj/.xcworkspace under XcodeGen or Tuist), " +
        "keeps no-new-dependency, and sets verifyCommand to swift test with a 15-minute timeout when Package.swift exists.",
      denyGeneratedPaths: true,
      defaults(facts) {
        const keep: KeepClause[] = [{ kind: "no-new-dependency" }];
        // Only SPM repos get a verifyCommand — never guess xcodebuild schemes.
        const spm = facts.some((f) => f.kind === SWIFTPM_PACKAGE);
        return {
          deny: [...APPLE_DENY],
          keep,
          ...(spm ? { verifyCommand: "swift test", verifyTimeoutMs: APPLE_VERIFY_TIMEOUT_MS } : {}),
        };
      },
    },
  ],
};
