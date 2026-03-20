/**
 * Ranked repo map ("cdir map"): the personalized-PageRank view of the index
 * around a set of anchor symbols, packed to a token budget.
 */

import { buildGraph, SymbolGraph } from "./graph";
import { rankSymbols, RankedSymbol } from "./rank";
import { RepoIndex, SymbolInfo } from "./types";

export interface MapOptions {
  /** Max entries to print (default 30). */
  top?: number;
  /** Approximate token budget; 1 token ≈ 4 chars (default 1024). */
  maxTokens?: number;
}

export interface RepoMapResult {
  anchors: SymbolInfo[];
  entries: RankedSymbol[];
  truncated: boolean;
  estimatedTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Resolve a free-text query to anchor symbols. */
export function resolveAnchors(graph: SymbolGraph, query: string): SymbolInfo[] {
  // 1. exact name match
  const exact = graph.byName.get(query);
  if (exact && exact.length > 0) return exact.map((id) => graph.symbols.get(id)!);

  const q = query.toLowerCase();
  const tokens = q.split(/[^a-zA-Z0-9_$]+/).filter((t) => t.length >= 3);

  // 2. case-insensitive exact name / qualified name
  const ci: SymbolInfo[] = [];
  for (const [id, sym] of graph.symbols) {
    if (sym.name.toLowerCase() === q || sym.qualifiedName.toLowerCase() === q) ci.push(sym);
    void id;
  }
  if (ci.length > 0) return ci;

  // 3. lexical: symbols whose name or file path contains any query token.
  //    Scored by number of matching tokens, deterministic tie-break by id.
  const scored: Array<{ sym: SymbolInfo; hits: number }> = [];
  for (const sym of graph.symbols.values()) {
    const hay = `${sym.name} ${sym.qualifiedName} ${sym.file}`.toLowerCase();
    const hits = tokens.filter((t) => hay.includes(t)).length;
    if (hits > 0) scored.push({ sym, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || a.sym.id.localeCompare(b.sym.id));
  return scored.slice(0, 5).map((s) => s.sym);
}

export function buildRepoMap(index: RepoIndex, query: string, opts: MapOptions = {}): RepoMapResult {
  const top = opts.top ?? 30;
  const maxTokens = opts.maxTokens ?? 1024;
  const graph = buildGraph(index);
  const anchors = resolveAnchors(graph, query);
  // Virtual "<toplevel>" nodes participate in the graph but not in the map.
  const ranked = rankSymbols(graph, anchors.map((a) => a.id)).filter(
    (r) => r.symbol.name !== "<toplevel>",
  );

  const entries: RankedSymbol[] = [];
  let tokens = 0;
  let truncated = false;
  for (const r of ranked) {
    if (entries.length >= top) {
      truncated = true;
      break;
    }
    const line = formatEntry(r);
    const cost = estimateTokens(line);
    if (tokens + cost > maxTokens && entries.length > 0) {
      truncated = true;
      break;
    }
    tokens += cost;
    entries.push(r);
  }
  return { anchors, entries, truncated, estimatedTokens: tokens };
}

function formatEntry(r: RankedSymbol): string {
  const s = r.symbol;
  return `${s.file}:${s.startLine}  ${s.qualifiedName} (${s.kind})  ${s.signature}`;
}

export function formatRepoMap(result: RepoMapResult, query: string): string {
  const lines: string[] = [];
  if (result.anchors.length === 0) {
    lines.push(`No anchor symbols matched "${query}". Index the repo first, or try a different query.`);
    return lines.join("\n");
  }
  lines.push(
    `Anchors: ${result.anchors.map((a) => a.qualifiedName).join(", ")}`,
    ``,
  );
  for (const r of result.entries) {
    lines.push(formatEntry(r));
  }
  lines.push(
    ``,
    `${result.entries.length} symbols, ~${result.estimatedTokens} tokens${result.truncated ? " (truncated to budget)" : ""}.`,
  );
  return lines.join("\n");
}
