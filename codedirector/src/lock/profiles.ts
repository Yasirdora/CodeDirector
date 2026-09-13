/**
 * Lock-draft presets (`cdir lock new --profile NAME`): a named bundle of
 * DraftOptions defaults for a platform. Profile values are DEFAULTS —
 * explicit flags add to list values (deny / keep / budget files) and
 * override scalar ones (verifyCommand). See mergeDraftOptions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DraftOptions } from "./draft";

/** Apple test suites (xcodebuild, swift test) need minutes, not the 60s default. */
export const APPLE_VERIFY_TIMEOUT_MS = 900_000;

export const PROFILE_NAMES = ["apple"];

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

/** XcodeGen (project.yml) and Tuist (Project.swift) generate the Xcode project — never hand-edit it. */
const GENERATED_PROJECT_MARKERS = ["project.yml", "Project.swift"];

/** Resolve a profile to draft defaults for the repo at rootDir; null when the name is unknown. */
export function getProfile(name: string, rootDir: string): DraftOptions | null {
  if (name !== "apple") return null;
  const deny = [...APPLE_DENY];
  if (GENERATED_PROJECT_MARKERS.some((m) => fs.existsSync(path.join(rootDir, m)))) {
    deny.push("*.xcodeproj/**", "*.xcworkspace/**");
  }
  const profile: DraftOptions = {
    deny,
    keep: [{ kind: "no-new-dependency" }],
  };
  // Only SPM repos get a verifyCommand — never guess xcodebuild schemes.
  if (fs.existsSync(path.join(rootDir, "Package.swift"))) {
    profile.verifyCommand = "swift test";
    profile.verifyTimeoutMs = APPLE_VERIFY_TIMEOUT_MS;
  }
  return profile;
}

/**
 * Merge explicit draft options over profile defaults: deny / keep /
 * budgetFiles concatenate (profile first), scalars from the explicit side
 * win when set.
 */
export function mergeDraftOptions(profile: DraftOptions, explicit: DraftOptions): DraftOptions {
  return {
    goal: explicit.goal ?? profile.goal,
    keep: [...(profile.keep ?? []), ...(explicit.keep ?? [])],
    deny: [...(profile.deny ?? []), ...(explicit.deny ?? [])],
    budgetFiles: [...(profile.budgetFiles ?? []), ...(explicit.budgetFiles ?? [])],
    verifyCommand: explicit.verifyCommand ?? profile.verifyCommand,
    verifyTimeoutMs: explicit.verifyTimeoutMs ?? profile.verifyTimeoutMs,
    maxProposedFiles: explicit.maxProposedFiles ?? profile.maxProposedFiles,
    now: explicit.now ?? profile.now,
    createdBy: explicit.createdBy ?? profile.createdBy,
  };
}
