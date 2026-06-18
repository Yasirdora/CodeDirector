/**
 * Tree-sitter WASM parser + per-file structural extraction.
 *
 * Uses web-tree-sitter (pure WASM, no native builds) with the official
 * TypeScript/TSX and JavaScript grammars, loaded from the .wasm files that
 * ship inside their npm packages.
 *
 * Extraction is per-file and self-contained: symbols, imports, and raw
 * (unresolved) call sites. Cross-file resolution happens in graph.ts so a
 * partial re-index can never leave stale edges behind.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Parser from "web-tree-sitter";
import { CallSite, FileIndex, ImportInfo, SymbolInfo, SymbolKind } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SyntaxNode = any;

/** Bump whenever extraction logic changes; stale entries are reparsed. */
export const PARSER_VERSION = 3;

export type LangKey = "typescript" | "tsx" | "javascript";

export function langForFile(relPath: string): LangKey {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    default:
      return "javascript";
  }
}

const WASM_PATHS: Record<LangKey, string> = {
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
};

export class StructuralParser {
  private parsers = new Map<LangKey, Parser>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await Parser.init();
    for (const key of Object.keys(WASM_PATHS) as LangKey[]) {
      const wasmPath = require.resolve(WASM_PATHS[key]);
      const lang = await Parser.Language.load(wasmPath);
      const p = new Parser();
      p.setLanguage(lang);
      this.parsers.set(key, p);
    }
    this.initialized = true;
  }

  /** Parse one file and extract its structural facts. hash computed by caller. */
  parseFile(relPath: string, source: string, hash: string): FileIndex {
    const parser = this.parsers.get(langForFile(relPath));
    if (!parser) throw new Error("parser not initialized");
    const tree = parser.parse(source);
    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const calls: CallSite[] = [];

    const root = tree.rootNode;
    for (const child of root.namedChildren) {
      this.extractTopLevel(child, relPath, source, symbols);
      if (child.type === "import_statement") {
        const imp = extractImport(child);
        if (imp) imports.push(imp);
      }
    }

    collectCalls(root, source, symbols, relPath, calls);

    symbols.sort((a, b) => a.id.localeCompare(b.id));
    imports.sort((a, b) => a.line - b.line || a.module.localeCompare(b.module));
    calls.sort(
      (a, b) => a.line - b.line || a.callerId.localeCompare(b.callerId) || a.calleeName.localeCompare(b.calleeName),
    );
    return { hash, parserVersion: PARSER_VERSION, symbols, imports, calls };
  }

  parseFileFromDisk(rootDir: string, relPath: string, hash: string): FileIndex {
    const source = fs.readFileSync(path.join(rootDir, relPath), "utf8");
    return this.parseFile(relPath, source, hash);
  }

  // ------------------------------------------------------------------

  private extractTopLevel(
    node: SyntaxNode,
    relPath: string,
    source: string,
    out: SymbolInfo[],
  ): void {
    let target = node;
    let exported = false;
    if (node.type === "export_statement") {
      exported = true;
      const decl = node.childForFieldName("declaration");
      if (!decl) return; // `export { a, b }` or `export * from ...`
      target = decl;
      if (hasDefaultKeyword(node)) exported = true;
    }
    const kind = kindForNode(target);
    if (kind === null) return;

    if (kind === "class") {
      const className = nameOf(target);
      if (!className) return;
      out.push(makeSymbol(relPath, target, "class", className, className, exported, source));
      const body = target.childForFieldName("body");
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === "method_definition" || member.type === "method_signature") {
            const mName = nameOf(member);
            if (!mName || mName === "constructor") continue;
            out.push(
              makeSymbol(relPath, member, "method", mName, `${className}.${mName}`, exported, source),
            );
          }
        }
      }
      return;
    }

    if (kind === "const") {
      // lexical_declaration / variable_declaration: one symbol per declarator,
      // exported declarations only (module-internal constants are noise here).
      if (!exported) return;
      for (const child of target.namedChildren) {
        if (child.type !== "variable_declarator") continue;
        const nameNode = child.childForFieldName("name");
        if (!nameNode || nameNode.type !== "identifier") continue;
        out.push(
          makeSymbol(relPath, child, "const", nameNode.text, nameNode.text, true, source),
        );
      }
      return;
    }

    const name = nameOf(target);
    if (!name) return;
    out.push(makeSymbol(relPath, target, kind, name, name, exported, source));
  }
}

// ----------------------------------------------------------------------

function kindForNode(node: SyntaxNode): SymbolKind | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return "function";
    case "class_declaration":
    case "abstract_class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "enum_declaration":
      return "enum";
    case "lexical_declaration":
    case "variable_declaration":
      return "const";
    default:
      return null;
  }
}

function nameOf(node: SyntaxNode): string | null {
  const n = node.childForFieldName("name");
  return n ? n.text : null;
}

function hasDefaultKeyword(exportNode: SyntaxNode): boolean {
  for (const c of exportNode.children) if (c.type === "default") return true;
  return false;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Node types that make a variable declarator a function-valued export. */
const FUNCTION_INITIALIZER_TYPES = new Set([
  "arrow_function",
  "function_expression",
  "generator_function_expression",
]);

/**
 * One-line signature: node text up to (not including) its body block.
 *
 * Function-valued declarators (`export const compose = <E>(a, b) => {…}`)
 * are the important case: cutting at the value initializer would discard the
 * entire parameter list, making the signature blind to API-breaking edits
 * (a field-reported defect: adding a parameter left the sha256 unchanged).
 * For those, the signature runs from the declarator name through type
 * parameters, the parameter list, and any return-type annotation, and cuts
 * at the function BODY (`=>` body / `{`).
 */
function signatureOf(node: SyntaxNode, source: string): string {
  let end = node.endIndex;
  const value = node.childForFieldName("value");
  if (value && FUNCTION_INITIALIZER_TYPES.has(value.type)) {
    const fnBody = value.childForFieldName("body");
    if (fnBody) end = fnBody.startIndex;
  } else {
    const body =
      node.childForFieldName("body") ??
      node.namedChildren.find(
        (c: SyntaxNode) => c.type === "statement_block" || c.type === "class_body",
      );
    if (body) end = body.startIndex;
    // For plain value declarators, cut at the value initializer.
    if (value && value.startIndex < end) end = value.startIndex;
  }
  let sig = collapseWs(source.slice(node.startIndex, end));
  if (sig.endsWith("=>")) sig = sig.slice(0, -2).trim();
  if (sig.endsWith("=")) sig = sig.slice(0, -1).trim();
  if (sig.length > 200) sig = sig.slice(0, 197) + "...";
  return sig;
}

function makeSymbol(
  relPath: string,
  node: SyntaxNode,
  kind: SymbolKind,
  name: string,
  qualifiedName: string,
  exported: boolean,
  source: string,
): SymbolInfo {
  return {
    id: `${relPath}#${qualifiedName}`,
    name,
    qualifiedName,
    kind,
    file: relPath,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    exported,
    signature: signatureOf(node, source),
  };
}

function extractImport(node: SyntaxNode): ImportInfo | null {
  const sourceNode = node.childForFieldName("source") ?? node.namedChildren.find((c: SyntaxNode) => c.type === "string");
  if (!sourceNode) return null;
  const module = sourceNode.text.replace(/^['"]|['"]$/g, "");
  const names: string[] = [];
  const clause = node.namedChildren.find((c: SyntaxNode) => c.type === "import_clause");
  if (clause) {
    for (const c of clause.namedChildren) {
      if (c.type === "identifier") {
        names.push("default:" + c.text);
      } else if (c.type === "namespace_import") {
        names.push("*");
      } else if (c.type === "named_imports") {
        for (const spec of c.namedChildren) {
          if (spec.type === "import_specifier") {
            const alias = spec.childForFieldName("alias");
            const name = spec.childForFieldName("name");
            names.push(alias ? `${name.text} as ${alias.text}` : name.text);
          }
        }
      }
    }
  }
  names.sort();
  return { module, names, line: node.startPosition.row + 1 };
}

/** Walk the whole tree collecting call sites; attribute each to its innermost symbol. */
function collectCalls(
  root: SyntaxNode,
  source: string,
  symbols: SymbolInfo[],
  relPath: string,
  out: CallSite[],
): void {
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression" || node.type === "new_expression") {
      // new_expression: constructor field instead of function field.
      const fn = node.childForFieldName("function") ?? node.childForFieldName("constructor");
      if (fn) {
        let calleeName: string | null = null;
        let isMethod = false;
        if (fn.type === "identifier") {
          calleeName = fn.text;
        } else if (fn.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          if (prop) {
            calleeName = prop.text;
            isMethod = true;
          }
        }
        if (calleeName && calleeName !== "require") {
          out.push({
            callerId: enclosingSymbolId(node, symbols, relPath),
            calleeName,
            isMethod,
            line: node.startPosition.row + 1,
          });
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
}

function enclosingSymbolId(node: SyntaxNode, symbols: SymbolInfo[], relPath: string): string {
  const line = node.startPosition.row + 1;
  let best: SymbolInfo | null = null;
  for (const s of symbols) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.startLine >= best.startLine) best = s;
    }
  }
  return best ? best.id : `${relPath}#<toplevel>`;
}
