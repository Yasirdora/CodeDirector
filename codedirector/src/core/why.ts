/**
 * Blast radius ("cdir why"): what could observably move if a symbol changes.
 *
 * Composes: definition sites, direct + transitive reverse call edges,
 * referencing test files, and historical co-change coupling from git.
 * Pure function of (index, git history) — no AI involved.
 */

import { coChange, CoChangeResult } from "./git";
import {
  buildGraph,
  directCallers,
  SymbolGraph,
  testFilesFor,
  transitiveCallers,
} from "./graph";
import { RepoIndex, SymbolInfo } from "./types";
import type { DomainRegistry } from "../domain/registry";

export interface BlastRadiusReport {
  query: string;
  matches: Array<{
    symbol: SymbolInfo;
    directCallers: SymbolInfo[];
    transitiveCallersByDepth: Array<{ depth: number; count: number; ids: string[] }>;
    transitiveTotal: number;
    testFiles: string[];
  }>;
  coChange: CoChangeResult;
}

/** Find symbols matching a query: exact name first, then substring (case-insensitive). */
export function findSymbols(graph: SymbolGraph, query: string): SymbolInfo[] {
  const exact = graph.byName.get(query) ?? [];
  if (exact.length > 0) return exact.map((id) => graph.symbols.get(id)!);
  const q = query.toLowerCase();
  const hits: SymbolInfo[] = [];
  for (const [id, sym] of [...graph.symbols.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (sym.name.toLowerCase().includes(q) || sym.qualifiedName.toLowerCase().includes(q) || id.toLowerCase().includes(q)) {
      hits.push(sym);
    }
  }
  return hits;
}

export const MAX_TRANSITIVE_DEPTH = 3;

export function blastRadius(
  rootDir: string,
  index: RepoIndex,
  query: string,
  maxDepth = MAX_TRANSITIVE_DEPTH,
  domains?: DomainRegistry,
): BlastRadiusReport {
  const graph = buildGraph(index, domains);
  const matches = findSymbols(graph, query);

  const reports = matches.map((symbol) => {
    const direct = directCallers(graph, symbol.id);
    const trans = transitiveCallers(graph, symbol.id, maxDepth);
    return {
      symbol,
      directCallers: direct,
      transitiveCallersByDepth: [...trans.byDepth.entries()].map(([depth, ids]) => ({
        depth,
        count: ids.length,
        ids,
      })),
      transitiveTotal: trans.total,
      testFiles: testFilesFor(index, symbol, domains),
    };
  });

  // Co-change is per defining file; use the first match's file (most common
  // case is a single match).
  const cc =
    matches.length > 0
      ? coChange(rootDir, matches[0].file)
      : { available: false, reason: "no matching symbol", commitsExamined: 0, top: [] };

  return { query, matches: reports, coChange: cc };
}

// ---------------------------------------------------------------------
// Human-readable rendering

export function formatBlastRadius(report: BlastRadiusReport): string {
  const lines: string[] = [];
  if (report.matches.length === 0) {
    lines.push(`No symbol matching "${report.query}" found in the index.`);
    return lines.join("\n");
  }
  for (const m of report.matches) {
    const s = m.symbol;
    lines.push(`${s.qualifiedName} (${s.kind}${s.exported ? ", exported" : ""})`);
    lines.push(`  defined:   ${s.file}:${s.startLine}-${s.endLine}`);
    lines.push(`  signature: ${s.signature}`);
    if (m.directCallers.length === 0) {
      lines.push("  callers:   none found (no resolved call edges)");
    } else {
      lines.push(`  callers (${m.directCallers.length}):`);
      for (const c of m.directCallers) {
        lines.push(`    ${c.qualifiedName}  ${c.file}:${c.startLine}`);
      }
    }
    if (m.transitiveCallersByDepth.length > 0) {
      lines.push(`  transitive callers (depth ≤ 3): ${m.transitiveTotal} total`);
      for (const lvl of m.transitiveCallersByDepth) {
        lines.push(`    depth ${lvl.depth}: ${lvl.count}`);
      }
    }
    if (m.testFiles.length > 0) {
      lines.push(`  tests referencing it (${m.testFiles.length}):`);
      for (const f of m.testFiles) lines.push(`    ${f}`);
    } else {
      lines.push("  tests referencing it: none found");
    }
  }
  const cc = report.coChange;
  if (cc.available) {
    if (cc.top.length > 0) {
      lines.push(`  co-change (from ${cc.commitsExamined} commits touching ${report.matches[0].symbol.file}):`);
      for (const t of cc.top) lines.push(`    ${t.file}  (${t.sharedCommits} shared commits)`);
    } else {
      lines.push("  co-change: no other files committed together with the defining file");
    }
  } else {
    lines.push(`  co-change: unavailable (${cc.reason ?? "unknown reason"})`);
  }
  return lines.join("\n");
}
