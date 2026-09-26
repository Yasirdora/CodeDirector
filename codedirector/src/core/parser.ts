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
import * as v8 from "node:v8";
import Parser from "web-tree-sitter";
import { CallSite, FileIndex, ImportInfo, SymbolInfo, SymbolKind } from "./types";
import { extractSwift } from "./swift";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SyntaxNode = any;

/** Bump whenever extraction logic changes; stale entries are reparsed. */
export const PARSER_VERSION = 5;

export type LangKey = "typescript" | "tsx" | "javascript" | "swift";

export function langForFile(relPath: string): LangKey {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case ".swift":
      return "swift";
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
  // Prebuilt by tree-sitter-wasms. The Swift grammar publishes only native
  // bindings of its own (node-gyp-build + prebuilds), which would cost this
  // package its "pure WASM, no native builds" property; this one ships the
  // .wasm the same way the grammars above do.
  swift: "tree-sitter-wasms/out/tree-sitter-swift.wasm",
};

/**
 * Up to this many Swift files in one indexing pass, the grammar runs on
 * V8's baseline WebAssembly compiler only (see chooseWasmTier).
 */
export const SWIFT_BASELINE_TIER_MAX_FILES = 3000;

let tierChosen = false;

/**
 * The Swift grammar is a large WebAssembly module. Once a Swift file is
 * parsed, V8 starts optimising that module in the background, and Node
 * waits for the job before the process can exit: measured on Node 22, a
 * `cdir run` that touched one Swift file took 8.4s, of which 0.1s was work.
 * V8's baseline compiler alone parses about 45% slower per file and costs
 * nothing at exit, so it wins until a single pass parses several thousand
 * Swift files — which only a first index of a very large app does.
 *
 * Decided once per process, before any grammar is compiled (the flag has
 * no effect on modules already compiled). A pass with no Swift files leaves
 * V8's defaults alone, so JavaScript/TypeScript indexing is as before.
 */
function chooseWasmTier(filesToParse: string[] | undefined): void {
  if (tierChosen) return;
  tierChosen = true;
  if (!filesToParse) return;
  const swift = filesToParse.filter((f) => langForFile(f) === "swift").length;
  if (swift > 0 && swift <= SWIFT_BASELINE_TIER_MAX_FILES) v8.setFlagsFromString("--liftoff-only");
}

export class StructuralParser {
  private parsers = new Map<LangKey, Parser>();
  private initialized = false;

  /** `filesToParse`, when known, lets the WebAssembly tier be chosen for the work ahead. */
  async init(filesToParse?: string[]): Promise<void> {
    if (this.initialized) return;
    chooseWasmTier(filesToParse);
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
    const lang = langForFile(relPath);
    const parser = this.parsers.get(lang);
    if (!parser) throw new Error("parser not initialized");
    const tree = parser.parse(source);
    // The one dispatch. Swift's node types share almost no names with
    // TypeScript's, so branching inside the extraction below would mean four
    // separate language switches that have to agree with each other.
    if (lang === "swift") {
      return extractSwift(relPath, tree.rootNode, source, hash, PARSER_VERSION);
    }
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
    markReExports(root, symbols);

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
  // Types/interfaces/enums ARE their signature — include the whole node.
  // Cutting at `body` made `interface I` identical for any members.
  if (
    node.type === "interface_declaration" ||
    node.type === "type_alias_declaration" ||
    node.type === "enum_declaration"
  ) {
    return collapseWs(source.slice(node.startIndex, node.endIndex));
  }

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
  return sig;
}

/** `export { foo }` / `export { foo as bar }` marks the local symbol exported. */
function markReExports(root: SyntaxNode, symbols: SymbolInfo[]): void {
  for (const child of root.namedChildren) {
    if (child.type !== "export_statement") continue;
    if (child.childForFieldName("declaration")) continue;
    const visit = (n: SyntaxNode) => {
      if (n.type === "export_specifier") {
        const name = n.childForFieldName("name");
        if (name) {
          for (const s of symbols) {
            if (s.name === name.text) s.exported = true;
          }
        }
      }
      for (const c of n.namedChildren) visit(c);
    };
    visit(child);
  }
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
