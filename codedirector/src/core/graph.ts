/**
 * Symbol graph: resolves raw call sites into edges and answers graph queries
 * (callers, transitive callers, test coverage). Derived entirely from a
 * RepoIndex; nothing here is persisted.
 *
 * Call resolution policy (documented, deterministic, best-effort):
 *   1. same-file    — a symbol with this name exists in the caller's file
 *   2. import       — the name is imported from a module that resolves to an
 *                     indexed file exporting a symbol of that name (the
 *                     registered domains resolve module specifiers)
 *   3. unique-name  — exactly one symbol in the whole index has that name
 *   4. method-name  — method calls (obj.m()) match methods named "m" using
 *                     the same steps; ambiguous matches are dropped
 * Unresolvable call sites are ignored (counted nowhere). This is heuristic
 * structural analysis, not type checking — the README states this plainly.
 *
 * Every edge says where it came from (core/provenance.ts): steps 1 and 2
 * are read from syntax ("tree-sitter"), steps 3 and 4 are a name heuristic
 * ("inferred"); all of them are asserted, never proven. The algorithms here
 * are shared by every domain — a domain contributes facts (how its imports
 * resolve, which files are its tests), never its own traversal.
 */

import { CallEdge, RepoIndex, SymbolInfo } from "./types";
import { compareProvenance, FactProvenance } from "./provenance";
import { defaultDomains, DomainRegistry } from "../domain/registry";

export interface SymbolGraph {
  symbols: Map<string, SymbolInfo>;
  /** name (bare) -> symbol ids, for name lookups. */
  byName: Map<string, string[]>;
  edges: CallEdge[];
  /** callerId -> set of calleeIds */
  outgoing: Map<string, Set<string>>;
  /** calleeId -> set of callerIds */
  incoming: Map<string, Set<string>>;
  /** All symbols per file, sorted. */
  filesOf: Map<string, SymbolInfo[]>;
}

/** `default:Foo` | `real as alias` | `name` → local binding and exported name. */
function parseImportName(n: string): { local: string; exported: string } {
  if (n.startsWith("default:")) return { local: n.slice("default:".length), exported: "default" };
  const idx = n.indexOf(" as ");
  if (idx !== -1) return { exported: n.slice(0, idx), local: n.slice(idx + 4) };
  return { local: n, exported: n };
}

/** Syntax-derived facts from the shared extractor. */
const SYNTAX: FactProvenance = { source: "tree-sitter", domain: "core", evidence: "asserted", freshness: "current" };
/** The unique-name / method-name heuristic. */
const INFERRED: FactProvenance = { source: "inferred", domain: "core", evidence: "asserted", freshness: "current" };

function sameProvenance(a: FactProvenance, b: FactProvenance): boolean {
  return a.source === b.source && a.domain === b.domain && a.evidence === b.evidence && a.freshness === b.freshness;
}

export function buildGraph(index: RepoIndex, domains: DomainRegistry = defaultDomains()): SymbolGraph {
  const symbols = new Map<string, SymbolInfo>();
  const byName = new Map<string, string[]>();
  const filesOf = new Map<string, SymbolInfo[]>();

  for (const file of Object.keys(index.files).sort()) {
    for (const sym of index.files[file].symbols) {
      symbols.set(sym.id, sym);
      const list = byName.get(sym.name) ?? [];
      list.push(sym.id);
      byName.set(sym.name, list);
      const fl = filesOf.get(file) ?? [];
      fl.push(sym);
      filesOf.set(file, fl);
    }
  }
  for (const list of byName.values()) list.sort();

  const edges: CallEdge[] = [];
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  const edgeByKey = new Map<string, CallEdge>();

  /** Top-level call sites get a virtual symbol so callers/transitive agree. */
  const ensureToplevel = (id: string) => {
    if (symbols.has(id)) return;
    const file = id.slice(0, -"#<toplevel>".length);
    const pseudo: SymbolInfo = {
      id,
      name: "<toplevel>",
      qualifiedName: "<toplevel>",
      kind: "function",
      file,
      startLine: 1,
      endLine: 1,
      exported: false,
      signature: "(top-level code)",
    };
    symbols.set(id, pseudo);
  };

  const addEdge = (
    fromId: string,
    toId: string,
    resolution: CallEdge["resolution"],
    provenance: FactProvenance,
  ) => {
    if (fromId === toId) return;
    if (!symbols.has(toId)) return;
    ensureToplevel(fromId);
    const key = `${fromId} >${toId}`;
    const existing = edgeByKey.get(key);
    if (existing) {
      // A second source for the same edge is kept beside the first, never
      // instead of it: stronger evidence ranks above, weaker stays visible.
      if (!existing.provenance.some((p) => sameProvenance(p, provenance))) {
        existing.provenance.push(provenance);
        existing.provenance.sort(compareProvenance);
      }
      return;
    }
    const edge: CallEdge = { fromId, toId, resolution, provenance: [provenance] };
    edgeByKey.set(key, edge);
    edges.push(edge);
    const out = outgoing.get(fromId) ?? new Set<string>();
    out.add(toId);
    outgoing.set(fromId, out);
    const inc = incoming.get(toId) ?? new Set<string>();
    inc.add(fromId);
    incoming.set(toId, inc);
  };

  const hasFile = (relPath: string) => index.files[relPath] !== undefined;
  for (const file of Object.keys(index.files).sort()) {
    const fi = index.files[file];
    // Map imported names -> resolved target file, for this file.
    const importTargets: Array<{ names: string[]; targetFile: string; provenance: FactProvenance }> = [];
    for (const imp of fi.imports) {
      const resolved = domains.resolveImport(file, imp.module, hasFile);
      if (resolved) importTargets.push({ names: imp.names, targetFile: resolved.target, provenance: resolved.provenance });
    }

    for (const call of fi.calls) {
      const candidates = byName.get(call.calleeName) ?? [];

      // 1. same-file
      const sameFile = candidates.filter((id) => symbols.get(id)!.file === file);
      if (sameFile.length > 0) {
        for (const id of sameFile) addEdge(call.callerId, id, "same-file", SYNTAX);
        continue;
      }
      // 2. via imports (including `import { realName as alias }`)
      let matched = false;
      for (const imp of importTargets) {
        const isWildcard = imp.names.includes("*");
        const bindings = imp.names.map(parseImportName);
        const bind = bindings.find((b) => b.local === call.calleeName);
        if (!isWildcard && !bind) continue;
        const exportedName = isWildcard ? call.calleeName : bind!.exported;
        const targetIds = (exportedName === "default" ? [...symbols.values()] : byName.get(exportedName) ?? [])
          .map((x) => (typeof x === "string" ? x : x.id))
          .filter((id) => {
            const s = symbols.get(id)!;
            return s.file === imp.targetFile && s.exported;
          });
        let ids = targetIds;
        if (exportedName === "default") {
          const named = targetIds.filter((id) => symbols.get(id)!.name === bind!.local);
          ids = named.length > 0 ? named : targetIds.length === 1 ? targetIds : [];
        }
        for (const id of ids) {
          addEdge(call.callerId, id, "import", imp.provenance);
          matched = true;
        }
      }
      if (matched) continue;
      // 3. unique name anywhere
      if (candidates.length === 1) {
        addEdge(call.callerId, candidates[0], call.isMethod ? "method-name" : "unique-name", INFERRED);
      }
    }
  }

  edges.sort((a, b) => (a.fromId + a.toId).localeCompare(b.fromId + b.toId));
  return { symbols, byName, edges, outgoing, incoming, filesOf };
}

// ---------------------------------------------------------------------
// Queries

/** Direct callers of a symbol (reverse call edges), sorted by id. */
export function directCallers(graph: SymbolGraph, symbolId: string): SymbolInfo[] {
  const ids = [...(graph.incoming.get(symbolId) ?? [])].sort();
  return ids.map((id) => graph.symbols.get(id)!).filter(Boolean);
}

/** Direct callees of a symbol, sorted by id. */
export function directCallees(graph: SymbolGraph, symbolId: string): SymbolInfo[] {
  const ids = [...(graph.outgoing.get(symbolId) ?? [])].sort();
  return ids.map((id) => graph.symbols.get(id)!).filter(Boolean);
}

export interface TransitiveCallers {
  /** depth (1..maxDepth) -> distinct caller ids first reached at that depth, sorted. */
  byDepth: Map<number, string[]>;
  total: number;
}

/** BFS over reverse call edges up to maxDepth. Deterministic ordering. */
export function transitiveCallers(
  graph: SymbolGraph,
  symbolId: string,
  maxDepth: number,
): TransitiveCallers {
  const byDepth = new Map<number, string[]>();
  const seen = new Set<string>([symbolId]);
  let frontier = [symbolId];
  let total = 0;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const caller of graph.incoming.get(id) ?? []) {
        if (!seen.has(caller)) {
          seen.add(caller);
          next.add(caller);
        }
      }
    }
    const level = [...next].sort();
    if (level.length > 0) byDepth.set(depth, level);
    total += level.length;
    frontier = level;
  }
  return { byDepth, total };
}

/** Whether any registered domain's conventions make this path a test file. */
export function isTestFile(relPath: string, domains: DomainRegistry = defaultDomains()): boolean {
  return domains.isTestFile(relPath);
}

/**
 * Test files that reference a symbol: a test file imports the symbol's
 * defining module, or the symbol's name literally appears in that file's
 * extracted facts (calls or imports). Heuristic, documented as such.
 */
export function testFilesFor(
  index: RepoIndex,
  symbol: SymbolInfo,
  domains: DomainRegistry = defaultDomains(),
): string[] {
  const out: string[] = [];
  const hasFile = (relPath: string) => index.files[relPath] !== undefined;
  for (const file of Object.keys(index.files).sort()) {
    if (!domains.isTestFile(file)) continue;
    const fi = index.files[file];
    const importsDefiningModule = fi.imports.some((imp) => {
      const target = domains.resolveImport(file, imp.module, hasFile)?.target ?? null;
      return target === symbol.file;
    });
    const namesSymbol = fi.imports.some((imp) =>
      imp.names.some((n) => n.replace(/^default:/, "").replace(/.* as /, "") === symbol.name),
    );
    const callsSymbol = fi.calls.some((c) => c.calleeName === symbol.name);
    if (importsDefiningModule || namesSymbol || callsSymbol) out.push(file);
  }
  return out.sort();
}
