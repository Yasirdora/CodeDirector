/**
 * Symbol graph: resolves raw call sites into edges and answers graph queries
 * (callers, transitive callers, test coverage). Derived entirely from a
 * RepoIndex; nothing here is persisted.
 *
 * Call resolution policy (documented, deterministic, best-effort):
 *   1. same-file    — a symbol with this name exists in the caller's file
 *   2. import       — the name is imported from a module that resolves to an
 *                     indexed file exporting a symbol of that name
 *   3. unique-name  — exactly one symbol in the whole index has that name
 *   4. method-name  — method calls (obj.m()) match methods named "m" using
 *                     the same steps; ambiguous matches are dropped
 * Unresolvable call sites are ignored (counted nowhere). This is heuristic
 * structural analysis, not type checking — the README states this plainly.
 */

import * as path from "node:path";
import { CallEdge, RepoIndex, SymbolInfo } from "./types";

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

/** Normalize a module specifier + importing file to an indexed relpath, or null. */
export function resolveModule(fromFile: string, specifier: string, index: RepoIndex): string | null {
  if (!specifier.startsWith(".")) return null; // external/bare imports are not indexed
  const fromDir = path.posix.dirname(fromFile);
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ];
  // specifier "./x.js" may refer to x.ts on disk (NodeNext style)
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  if (stripped !== base) {
    candidates.push(`${stripped}.ts`, `${stripped}.tsx`);
  }
  for (const c of candidates) {
    if (index.files[c]) return c;
  }
  return null;
}

export function buildGraph(index: RepoIndex): SymbolGraph {
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
  const edgeKeys = new Set<string>();

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

  const addEdge = (fromId: string, toId: string, resolution: CallEdge["resolution"]) => {
    if (fromId === toId) return;
    if (!symbols.has(toId)) return;
    ensureToplevel(fromId);
    const key = `${fromId} >${toId}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ fromId, toId, resolution });
    const out = outgoing.get(fromId) ?? new Set<string>();
    out.add(toId);
    outgoing.set(fromId, out);
    const inc = incoming.get(toId) ?? new Set<string>();
    inc.add(fromId);
    incoming.set(toId, inc);
  };

  for (const file of Object.keys(index.files).sort()) {
    const fi = index.files[file];
    // Map imported names -> resolved target file, for this file.
    const importTargets: Array<{ names: string[]; targetFile: string }> = [];
    for (const imp of fi.imports) {
      const targetFile = resolveModule(file, imp.module, index);
      if (targetFile) importTargets.push({ names: imp.names, targetFile });
    }

    for (const call of fi.calls) {
      const candidates = byName.get(call.calleeName) ?? [];
      if (candidates.length === 0) continue;

      // 1. same-file
      const sameFile = candidates.filter((id) => symbols.get(id)!.file === file);
      if (sameFile.length > 0) {
        for (const id of sameFile) addEdge(call.callerId, id, "same-file");
        continue;
      }
      // 2. via imports
      let matched = false;
      for (const imp of importTargets) {
        const importedNames = imp.names.map((n) => n.replace(/^default:/, "").replace(/.* as /, ""));
        const isWildcard = imp.names.includes("*");
        if (!isWildcard && !importedNames.includes(call.calleeName)) continue;
        for (const id of candidates) {
          if (symbols.get(id)!.file === imp.targetFile && symbols.get(id)!.exported) {
            addEdge(call.callerId, id, "import");
            matched = true;
          }
        }
      }
      if (matched) continue;
      // 3. unique name anywhere
      if (candidates.length === 1) {
        addEdge(call.callerId, candidates[0], call.isMethod ? "method-name" : "unique-name");
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

const TEST_FILE_RE = /(__tests__\/|\.(test|spec)\.[cm]?[tj]sx?$)/;

export function isTestFile(relPath: string): boolean {
  return TEST_FILE_RE.test(relPath);
}

/**
 * Test files that reference a symbol: a test file imports the symbol's
 * defining module, or the symbol's name literally appears in that file's
 * extracted facts (calls or imports). Heuristic, documented as such.
 */
export function testFilesFor(index: RepoIndex, symbol: SymbolInfo): string[] {
  const out: string[] = [];
  for (const file of Object.keys(index.files).sort()) {
    if (!isTestFile(file)) continue;
    const fi = index.files[file];
    const importsDefiningModule = fi.imports.some((imp) => {
      const target = resolveModule(file, imp.module, index);
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
