/**
 * W12: a Package.swift counts for no-new-dependency by its `.package(…)`
 * entries, not as a whole file — a target, a resource or a comment is not a
 * new dependency.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { hashContent } from "../src/core/builder";
import { defaultDomains } from "../src/domain/registry";
import { swiftPackageEntries, swiftPackageFingerprint } from "../src/domains/apple/deps";

const PACKAGE = `// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Core",
    platforms: [.iOS(.v26)],
    products: [.library(name: "Core", targets: ["Core"])],
    dependencies: [
        .package(path: "../Engine"),
        .package(url: "https://example.com/markdown.git", from: "1.2.0"),
    ],
    targets: [
        .target(name: "Core", dependencies: ["Engine", .product(name: "Markdown", package: "markdown")]),
        .testTarget(name: "CoreTests", dependencies: ["Core"]),
    ]
)
`;

test("swift deps: a target, a resource, a platform or a comment is not a new dependency", () => {
  const before = swiftPackageFingerprint(PACKAGE);
  const edited = PACKAGE.replace(
    `.testTarget(name: "CoreTests", dependencies: ["Core"]),`,
    `.testTarget(name: "CoreTests", dependencies: ["Core"], resources: [.copy("Fixtures")]),\n        .target(name: "Extra"),`,
  )
    .replace("platforms: [.iOS(.v26)],", "platforms: [.iOS(.v26), .macOS(.v26)],")
    .replace("import PackageDescription", "import PackageDescription\n// the shared core");
  assert.notEqual(edited, PACKAGE);
  assert.equal(swiftPackageFingerprint(edited), before);
});

test("swift deps: a package added, removed or moved to another version is", () => {
  const before = swiftPackageFingerprint(PACKAGE);
  const added = PACKAGE.replace(
    `.package(path: "../Engine"),`,
    `.package(path: "../Engine"),\n        .package(url: "https://example.com/left-pad.git", exact: "0.1.0"),`,
  );
  const removed = PACKAGE.replace(`        .package(path: "../Engine"),\n`, "");
  const bumped = PACKAGE.replace(`from: "1.2.0"`, `from: "2.0.0"`);
  for (const changed of [added, removed, bumped]) {
    assert.notEqual(changed, PACKAGE);
    assert.notEqual(swiftPackageFingerprint(changed), before);
  }
});

test("swift deps: order, spacing and line breaks inside an entry do not count", () => {
  const reordered = PACKAGE.replace(
    `        .package(path: "../Engine"),\n        .package(url: "https://example.com/markdown.git", from: "1.2.0"),`,
    `        .package(\n            url: "https://example.com/markdown.git",\n            from: "1.2.0"\n        ),\n        .package( path : "../Engine" ),`,
  );
  assert.notEqual(reordered, PACKAGE);
  assert.equal(swiftPackageFingerprint(reordered), swiftPackageFingerprint(PACKAGE));
});

test("swift deps: a commented-out package does not count, and a URL's // is not a comment", () => {
  assert.deepEqual(swiftPackageEntries(PACKAGE), [
    `.package(path:"../Engine")`,
    `.package(url:"https://example.com/markdown.git",from:"1.2.0")`,
  ]);
  const commented = PACKAGE.replace(
    `        .package(path: "../Engine"),`,
    `        .package(path: "../Engine"),\n        // .package(url: "https://example.com/old.git", from: "1.0.0"),\n        /* .package(path: "../Old") */`,
  );
  assert.equal(swiftPackageFingerprint(commented), swiftPackageFingerprint(PACKAGE));
});

test("swift deps: every Package.swift in the project gets the fingerprint, and an older whole-file hash still holds", () => {
  const domains = defaultDomains();
  const edited = PACKAGE.replace("platforms: [.iOS(.v26)],", "platforms: [.iOS(.v26), .macOS(.v26)],");
  assert.equal(domains.manifestFingerprint("apple/Core/Package.swift", edited), swiftPackageFingerprint(PACKAGE));
  assert.equal(domains.manifestFingerprint("Package.swift", PACKAGE), swiftPackageFingerprint(PACKAGE));
  // A baseline from before W12 holds the whole-file hash: the same bytes hold, other bytes do not.
  const old = hashContent(PACKAGE);
  assert.equal(domains.manifestUnchanged("apple/Core/Package.swift", PACKAGE, old), true);
  assert.equal(domains.manifestUnchanged("apple/Core/Package.swift", edited, old), false);
  assert.equal(domains.manifestUnchanged("apple/Core/Package.swift", edited, swiftPackageFingerprint(PACKAGE)), true);
});
