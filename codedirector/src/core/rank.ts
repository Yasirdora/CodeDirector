/**
 * Symbol ranking: personalized PageRank over the symbol graph.
 *
 * Nodes are symbols. Undirected adjacency is built from resolved call edges
 * (weight 1.0, both directions — relevance flows caller<->callee) plus
 * same-file co-membership (weight 0.15, spreading a little relevance to
 * neighbors in the same file). The restart vector is uniform over the
 * anchor symbols; everything else restarts at 0.
 *
 * rank(v) = (1 - d) * restart(v) + d * Σ_u w(u,v) * rank(u) / outWeight(u)
 *
 * with d = 0.85, 50 fixed Gauss-Seidel-style iterations over sorted node
 * ids. Fully deterministic: identical index + anchors => identical ranks.
 * (This is the same family of approach as Aider's repo map; implemented
 * from scratch against our own graph.)
 */

import { SymbolGraph } from "./graph";
import { SymbolInfo } from "./types";

export const PAGERANK_DAMPING = 0.85;
export const PAGERANK_ITERATIONS = 50;
export const SAME_FILE_WEIGHT = 0.15;
export const CALL_WEIGHT = 1.0;

export interface RankedSymbol {
  symbol: SymbolInfo;
  score: number;
}

export function rankSymbols(graph: SymbolGraph, anchorIds: string[]): RankedSymbol[] {
  const nodes = [...graph.symbols.keys()].sort();
  const anchors = new Set(anchorIds.filter((id) => graph.symbols.has(id)));
  if (nodes.length === 0) return [];

  const restart = new Map<string, number>();
  if (anchors.size > 0) {
    const w = 1 / anchors.size;
    for (const id of anchors) restart.set(id, w);
  } else {
    // No valid anchors: uniform restart == plain PageRank.
    const w = 1 / nodes.length;
    for (const id of nodes) restart.set(id, w);
  }

  // Undirected weighted adjacency.
  const adj = new Map<string, Map<string, number>>();
  const addAdj = (a: string, b: string, w: number) => {
    if (a === b) return;
    const m = adj.get(a) ?? new Map<string, number>();
    m.set(b, (m.get(b) ?? 0) + w);
    adj.set(a, m);
  };
  for (const e of graph.edges) {
    addAdj(e.fromId, e.toId, CALL_WEIGHT);
    addAdj(e.toId, e.fromId, CALL_WEIGHT);
  }
  for (const [file, syms] of graph.filesOf) {
    void file;
    const ids = syms.map((s) => s.id).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        addAdj(ids[i], ids[j], SAME_FILE_WEIGHT);
        addAdj(ids[j], ids[i], SAME_FILE_WEIGHT);
      }
    }
  }

  const outWeight = new Map<string, number>();
  for (const id of nodes) {
    let sum = 0;
    for (const w of adj.get(id)?.values() ?? []) sum += w;
    outWeight.set(id, sum);
  }

  const d = PAGERANK_DAMPING;
  let rank = new Map<string, number>();
  for (const id of nodes) rank.set(id, restart.get(id) ?? 0);

  for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
    const next = new Map<string, number>();
    for (const id of nodes) {
      let incoming = 0;
      for (const [nbr, w] of adj.get(id) ?? []) {
        const ow = outWeight.get(nbr) ?? 0;
        if (ow > 0) incoming += (w * (rank.get(nbr) ?? 0)) / ow;
      }
      next.set(id, (1 - d) * (restart.get(id) ?? 0) + d * incoming);
    }
    rank = next;
  }

  const result: RankedSymbol[] = nodes.map((id) => ({
    symbol: graph.symbols.get(id)!,
    score: rank.get(id) ?? 0,
  }));
  // Sort by score desc; ties broken by symbol id for determinism.
  result.sort((a, b) => b.score - a.score || a.symbol.id.localeCompare(b.symbol.id));
  return result;
}
