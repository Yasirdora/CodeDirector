/**
 * Ranked repo map ("cdir map"): the personalized-PageRank view of the index
 * around a set of anchor symbols, packed to a token budget.
 */

import { buildGraph, SymbolGraph } from "./graph";
import { rankSymbols, RankedSymbol } from "./rank";
import { RepoIndex, SymbolInfo } from "./types";
import type { DomainRegistry } from "../domain/registry";

export interface MapOptions {
  /** Max entries to print (default 30). */
  top?: number;
  /** Approximate token budget; 1 token ≈ 4 chars (default 1024). */
  maxTokens?: number;
  /** Domains whose facts the graph is built from (default: the built-in ones). */
  domains?: DomainRegistry;
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

/** How strongly the query matched: exact > name-token > lexical-only > none. */
export type AnchorStrength = "exact" | "name" | "lexical" | "none";

/**
 * How one anchor came to be chosen — the evidence a draft owes the human.
 *
 * `how` is the load-bearing field. "part" means the utterance token merely
 * OCCURS INSIDE the symbol's name ("tabs" inside `tabSetFor`), which is how
 * every mis-anchor reported from the field has happened: an incidental
 * English word lands in an unrelated territory and the budget follows it.
 */
export interface AnchorMatch {
  symbol: SymbolInfo;
  /** The utterance token that matched — the whole query for an exact hit. */
  token: string;
  how: "exact" | "whole" | "part" | "lexical";
}

export interface AnchorResolution {
  anchors: SymbolInfo[];
  strength: AnchorStrength;
  /** Parallel to `anchors`, same order: why each one is here. */
  matches: AnchorMatch[];
}

/**
 * Resolve a free-text query to anchor symbols, with an explicit strength
 * tier. Field-reported on Hono: the purely lexical fallback let generic
 * words ("make", "the") anchor on unrelated adapter files, so budget
 * proposals had nothing to do with the query. Name-bearing matches now win
 * over lexical fuzz, and the strength is exposed so callers can abstain when
 * the match is weak.
 */
export function resolveAnchorsDetailed(graph: SymbolGraph, query: string): AnchorResolution {
  // 1. exact name match
  const exact = graph.byName.get(query);
  if (exact && exact.length > 0) {
    const anchors = exact.map((id) => graph.symbols.get(id)!);
    return { anchors, strength: "exact", matches: anchors.map((s) => named(s, query, "exact")) };
  }

  const q = query.toLowerCase();
  const tokens = q.split(/[^a-zA-Z0-9_$]+/).filter((t) => t.length >= 3);

  // 2. case-insensitive exact name / qualified name
  const ci: SymbolInfo[] = [];
  for (const sym of graph.symbols.values()) {
    if (sym.name.toLowerCase() === q || sym.qualifiedName.toLowerCase() === q) ci.push(sym);
  }
  if (ci.length > 0) {
    return { anchors: ci, strength: "exact", matches: ci.map((s) => named(s, query, "exact")) };
  }

  // 3. name-token match: a query token that IS a symbol name (len ≥ 3) or
  //    appears inside one (len ≥ 4, so "the" can't match "other"). These are
  //    real anchors; lexical fuzz below is not.
  const nameHits = new Map<string, AnchorMatch>();
  for (const sym of graph.symbols.values()) {
    const nm = sym.name.toLowerCase();
    const qn = sym.qualifiedName.toLowerCase();
    let best: AnchorMatch | undefined;
    for (const t of tokens) {
      const whole = t === nm || t === qn;
      const part = !whole && t.length >= 4 && (nm.includes(t) || qn.includes(t));
      if (!whole && !part) continue;
      // A whole-name hit is the strongest evidence this symbol can offer;
      // a substring hit is kept only until a whole one turns up.
      if (whole) {
        best = named(sym, t, "whole");
        break;
      }
      if (!best) best = named(sym, t, "part");
    }
    if (best) nameHits.set(sym.id, best);
  }
  if (nameHits.size > 0) {
    // Identity beats coincidence, and beats it by exclusion rather than by
    // sort order. A token that IS a symbol's name and a token that merely
    // occurs inside one are evidence of different kinds; ranked together,
    // five coincidences could fill the list before the identity was
    // reached. Measured on a sentence that said "ScriptSurface paints the
    // mark in the wrong coordinate space" and anchored on isLetterSpaced,
    // addPages and three ElementModeButton members — "space", "page",
    // "mode" — while ScriptSurface, which the sentence names, was absent.
    //
    // Sorting whole matches first would not have been enough: fragments
    // would still have filled the remaining slots and shared the budget
    // proposal. When anything matched wholly, fragments are not anchors.
    const found = [...nameHits.values()];
    const whole = found.filter((m) => m.how === "whole");
    const picked = (whole.length > 0 ? whole : found)
      .sort((a, b) => a.symbol.id.localeCompare(b.symbol.id))
      .slice(0, 5);
    return { anchors: picked.map((m) => m.symbol), strength: "name", matches: picked };
  }

  // 4. lexical: symbols whose name or file path contains any query token.
  //    Scored by number of matching tokens, deterministic tie-break by id.
  //    WEAK — callers should treat these as hints, not anchors.
  const scored: Array<{ sym: SymbolInfo; hits: number }> = [];
  for (const sym of graph.symbols.values()) {
    const hay = `${sym.name} ${sym.qualifiedName} ${sym.file}`.toLowerCase();
    const hits = tokens.filter((t) => hay.includes(t)).length;
    if (hits > 0) scored.push({ sym, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || a.sym.id.localeCompare(b.sym.id));
  const anchors = scored.slice(0, 5).map((s) => s.sym);
  const matches = anchors.map((sym) => {
    const hay = `${sym.name} ${sym.qualifiedName} ${sym.file}`.toLowerCase();
    return named(sym, tokens.find((t) => hay.includes(t)) ?? q, "lexical");
  });
  return { anchors, strength: anchors.length > 0 ? "lexical" : "none", matches };
}

function named(symbol: SymbolInfo, token: string, how: AnchorMatch["how"]): AnchorMatch {
  return { symbol, token, how };
}

/** Resolve a free-text query to anchor symbols. */
export function resolveAnchors(graph: SymbolGraph, query: string): SymbolInfo[] {
  return resolveAnchorsDetailed(graph, query).anchors;
}

export function buildRepoMap(index: RepoIndex, query: string, opts: MapOptions = {}): RepoMapResult {
  const top = opts.top ?? 30;
  const maxTokens = opts.maxTokens ?? 1024;
  const graph = buildGraph(index, opts.domains);
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
