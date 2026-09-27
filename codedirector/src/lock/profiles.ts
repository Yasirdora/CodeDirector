/**
 * Lock-draft presets (`cdir lock new --profile NAME`): a named bundle of
 * DraftOptions defaults for a platform. Profile values are DEFAULTS —
 * explicit flags add to list values (deny / keep / budget files) and
 * override scalar ones (verifyCommand). See mergeDraftOptions.
 *
 * The mechanism is the core's; the presets are the domains'. A domain's
 * ProfileRule says what to deny, keep and verify for a project with the
 * facts it detects; this module looks the profile up, adds the paths the
 * domain says a generator owns here, and merges the result with the
 * human's flags.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DraftOptions } from "./draft";
import { defaultDomains, DomainRegistry } from "../domain/registry";

/** Names of the profiles the built-in domains register. */
export const PROFILE_NAMES: string[] = defaultDomains().profileNames();

/** Resolve a profile to draft defaults for the repo at rootDir; null when the name is unknown. */
export function getProfile(
  name: string,
  rootDir: string,
  domains: DomainRegistry = defaultDomains(),
): DraftOptions | null {
  const found = domains.profile(name);
  if (!found) return null;
  const { rule, domain } = found;
  const defaults = rule.defaults(domains.projectFacts(rootDir));
  const deny = [...(defaults.deny ?? [])];
  if (rule.denyGeneratedPaths) {
    for (const g of domain.generatedPathRules?.generatedByMarker ?? []) {
      if (g.markers.some((m) => fs.existsSync(path.join(rootDir, m)))) deny.push(...g.paths);
    }
  }
  const profile: DraftOptions = { deny };
  if (defaults.keep !== undefined) profile.keep = [...defaults.keep];
  if (defaults.verifyCommand !== undefined) profile.verifyCommand = defaults.verifyCommand;
  if (defaults.verifyTimeoutMs !== undefined) profile.verifyTimeoutMs = defaults.verifyTimeoutMs;
  return profile;
}

/** The MCP `profile` parameter's description: every registered profile, in its domain's words. */
export function describeProfiles(domains: DomainRegistry = defaultDomains()): string {
  const names = domains.profileNames();
  const summaries = names.map((n) => `"${n}" ${domains.profile(n)!.rule.summary}`);
  return [`Optional draft preset (available: ${names.join(", ")}).`, ...summaries].join(" ");
}

/** Concatenate optional lists; undefined stays undefined (an absent list is not written into a draft). */
function mergeOptionalList(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  return [...(a ?? []), ...(b ?? [])];
}

/**
 * Merge explicit draft options over profile defaults: deny / keep /
 * budgetFiles / accept / verifyCovers concatenate (profile first), scalars
 * (goal, verifyCommand, ceilings, …) from the explicit side win when set.
 */
export function mergeDraftOptions(profile: DraftOptions, explicit: DraftOptions): DraftOptions {
  return {
    goal: explicit.goal ?? profile.goal,
    keep: [...(profile.keep ?? []), ...(explicit.keep ?? [])],
    deny: [...(profile.deny ?? []), ...(explicit.deny ?? [])],
    budgetFiles: [...(profile.budgetFiles ?? []), ...(explicit.budgetFiles ?? [])],
    verifyCommand: explicit.verifyCommand ?? profile.verifyCommand,
    verifyTimeoutMs: explicit.verifyTimeoutMs ?? profile.verifyTimeoutMs,
    verifyCovers: mergeOptionalList(profile.verifyCovers, explicit.verifyCovers),
    accept: [...(profile.accept ?? []), ...(explicit.accept ?? [])],
    maxFiles: explicit.maxFiles ?? profile.maxFiles,
    maxLines: explicit.maxLines ?? profile.maxLines,
    maxProposedFiles: explicit.maxProposedFiles ?? profile.maxProposedFiles,
    now: explicit.now ?? profile.now,
    createdBy: explicit.createdBy ?? profile.createdBy,
  };
}
