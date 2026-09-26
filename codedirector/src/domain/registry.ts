/**
 * The domain registry: the one place the core asks what the registered
 * domains know.
 *
 * Every query unions the domains' contributions in registration order, so
 * the core never names a domain and a new domain changes no core file. The
 * registry answers questions; it runs nothing — checks it returns are
 * descriptions the core executes.
 *
 * All registered domains contribute unconditionally. Activating a domain by
 * what the project is (projectFacts) is a later decision; doing it now would
 * change what an existing repo is judged by.
 */

import { hashContent } from "../core/builder";
import type { FactProvenance } from "../core/provenance";
import { builtinDomains } from "../domains/builtin";
import type {
  ChangeClassifier,
  DependencyManifest,
  DiagnosticsCheck,
  Domain,
  ProfileRule,
  ProjectFact,
  TestRunnerDescription,
  ToolchainReach,
} from "./types";

export class DomainRegistryError extends Error {}

export class DomainRegistry {
  private readonly list: readonly Domain[];

  constructor(domains: Domain[]) {
    const ids = new Set<string>();
    const profiles = new Map<string, string>();
    const checks = new Set<string>();
    let runner: string | null = null;
    for (const d of domains) {
      if (ids.has(d.id)) throw new DomainRegistryError(`domain "${d.id}" registered twice`);
      ids.add(d.id);
      for (const p of d.profileRules ?? []) {
        const owner = profiles.get(p.name);
        if (owner) throw new DomainRegistryError(`profile "${p.name}" is registered by both "${owner}" and "${d.id}"`);
        profiles.set(p.name, d.id);
      }
      for (const c of d.checkProviders?.diagnostics ?? []) {
        if (checks.has(c.id)) throw new DomainRegistryError(`diagnostics check "${c.id}" registered twice`);
        checks.add(c.id);
      }
      if (d.checkProviders?.testRunner) {
        // tests-pass names no runner, so a second one would make it ambiguous.
        if (runner) {
          throw new DomainRegistryError(
            `tests-pass runner registered by both "${runner}" and "${d.id}" — the clause can have one runner`,
          );
        }
        runner = d.id;
      }
    }
    this.list = [...domains];
  }

  get domains(): readonly Domain[] {
    return this.list;
  }

  get(id: string): Domain | undefined {
    return this.list.find((d) => d.id === id);
  }

  // --- generatedPathRules ------------------------------------------------

  /** Directory names no domain wants indexed, in registration order, deduplicated. */
  neverSourceDirs(): string[] {
    return unique(this.list.flatMap((d) => d.generatedPathRules?.neverSourceDirs ?? []));
  }

  // --- graphFacts --------------------------------------------------------

  /** The first domain's resolution of an import, with its provenance; null when none resolves it. */
  resolveImport(
    fromFile: string,
    specifier: string,
    hasFile: (relPath: string) => boolean,
  ): { target: string; provenance: FactProvenance } | null {
    for (const d of this.list) {
      const r = d.graphFacts?.resolveImport(fromFile, specifier, hasFile);
      if (!r) continue;
      return {
        target: r.target,
        provenance: { source: r.source ?? "tree-sitter", domain: d.id, evidence: "asserted", freshness: "current" },
      };
    }
    return null;
  }

  // --- testMapping -------------------------------------------------------

  /** The domain whose conventions make this path a test, or null. */
  testDomainOf(relPath: string): Domain | null {
    return this.list.find((d) => d.testMapping?.isTestFile(relPath)) ?? null;
  }

  isTestFile(relPath: string): boolean {
    return this.testDomainOf(relPath) !== null;
  }

  /**
   * Deny globs for test files: each file goes to the domain that claims it,
   * and each domain compresses its own. A domain without a compressor gets
   * its files listed singly.
   */
  compressTestPaths(testFiles: string[]): string[] {
    const byDomain = new Map<Domain, string[]>();
    const unowned: string[] = [];
    for (const f of testFiles) {
      const d = this.testDomainOf(f);
      if (!d) {
        unowned.push(f);
        continue;
      }
      byDomain.set(d, [...(byDomain.get(d) ?? []), f]);
    }
    const out: string[] = [];
    for (const d of this.list) {
      const files = byDomain.get(d);
      if (!files) continue;
      out.push(...(d.testMapping?.compressTestPaths ? d.testMapping.compressTestPaths(files) : [...files].sort()));
    }
    out.push(...unowned.sort());
    return out;
  }

  // --- dependencyFacts ---------------------------------------------------

  /** Every dependency manifest, in registration order; the first claim on a path wins. */
  dependencyManifests(): DependencyManifest[] {
    const seen = new Set<string>();
    const out: DependencyManifest[] = [];
    for (const d of this.list) {
      for (const m of d.dependencyFacts?.manifests ?? []) {
        if (seen.has(m.path)) continue;
        seen.add(m.path);
        out.push(m);
      }
    }
    return out;
  }

  /** What a manifest's content counts as for no-new-dependency: its domain's fingerprint, else its hash. */
  manifestFingerprint(manifestPath: string, raw: string): string {
    const m = this.dependencyManifests().find((x) => x.path === manifestPath);
    return m?.fingerprint ? m.fingerprint(raw) : hashContent(raw);
  }

  // --- checkProviders ----------------------------------------------------

  diagnosticsChecks(): DiagnosticsCheck[] {
    return this.list.flatMap((d) => d.checkProviders?.diagnostics ?? []);
  }

  /** The tests-pass runner and the domain that registered it, or null. */
  testRunner(): { runner: TestRunnerDescription; domain: Domain } | null {
    for (const d of this.list) {
      if (d.checkProviders?.testRunner) return { runner: d.checkProviders.testRunner, domain: d };
    }
    return null;
  }

  toolchains(): ToolchainReach[] {
    return this.list.flatMap((d) => d.checkProviders?.toolchains ?? []);
  }

  // --- changeClassifiers -------------------------------------------------

  changeClassifiers(): ChangeClassifier[] {
    return this.list.flatMap((d) => d.changeClassifiers ?? []);
  }

  // --- profileRules / projectFacts ---------------------------------------

  profileNames(): string[] {
    return this.list.flatMap((d) => (d.profileRules ?? []).map((p) => p.name));
  }

  profile(name: string): { rule: ProfileRule; domain: Domain } | null {
    for (const d of this.list) {
      const rule = d.profileRules?.find((p) => p.name === name);
      if (rule) return { rule, domain: d };
    }
    return null;
  }

  projectFacts(rootDir: string): ProjectFact[] {
    return this.list.flatMap((d) => d.projectFacts?.detect(rootDir) ?? []);
  }
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

let builtin: DomainRegistry | null = null;

/** The registry of the domains that ship with Code Director (Node, Apple). */
export function defaultDomains(): DomainRegistry {
  if (!builtin) builtin = new DomainRegistry(builtinDomains());
  return builtin;
}
