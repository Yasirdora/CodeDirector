/**
 * Swift structural extraction.
 *
 * Its own module, and the reason is the shape of the alternative: the
 * TypeScript extractor would otherwise grow a language switch in
 * `kindForNode`, in the top-level walk, in the member walk and in
 * `signatureOf` — four places that must agree, which is where this kind of
 * code rots. `parser.ts` keeps the runtime and dispatches here once.
 *
 * Read from the grammar rather than from the language spec, because the
 * grammar is what the parser actually produces:
 *
 *  - `class_declaration` is the node for `struct`, `class`, `enum`, `actor`
 *    AND `extension`. The keyword is an UNNAMED child and is the only thing
 *    that tells them apart.
 *  - an extension reports the name of the type it extends, so
 *    `extension Surface` and `struct Surface` in one file would claim the
 *    same symbol id. Extensions are qualified away — see `extensionName`.
 *  - members hang off `class_body` / `protocol_body`; a member function is
 *    a `function_declaration`, the same node as a free function.
 */

import { CallSite, FileIndex, ImportInfo, SymbolInfo, SymbolKind } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SyntaxNode = any;

/** Keywords that a `class_declaration` may be introduced by. */
type DeclKeyword = "struct" | "class" | "enum" | "actor" | "extension";
const DECL_KEYWORDS: DeclKeyword[] = ["struct", "class", "enum", "actor", "extension"];

/** Which keyword introduced this declaration, read from its unnamed children. */
function declKeyword(node: SyntaxNode): DeclKeyword | null {
  for (const child of node.children) {
    if (!child.isNamed && (DECL_KEYWORDS as string[]).includes(child.text)) {
      return child.text as DeclKeyword;
    }
  }
  return null;
}

/**
 * Swift's default access is `internal`, which is module-wide and therefore
 * says nothing about API surface. Only `public` and `open` are treated as
 * exported — the same intent as the TypeScript extractor's `export`.
 */
function isExported(node: SyntaxNode): boolean {
  const modifiers = node.namedChildren.find((c: SyntaxNode) => c.type === "modifiers");
  if (!modifiers) return false;
  return /\b(public|open)\b/.test(modifiers.text);
}

function bodyOf(node: SyntaxNode): SyntaxNode | null {
  return (
    node.childForFieldName("body") ??
    node.namedChildren.find(
      (c: SyntaxNode) => c.type === "class_body" || c.type === "protocol_body",
    ) ??
    null
  );
}

function nameOf(node: SyntaxNode): string | null {
  const named = node.childForFieldName("name");
  if (named) return named.text;
  const ident = node.namedChildren.find(
    (c: SyntaxNode) =>
      c.type === "simple_identifier" || c.type === "type_identifier" || c.type === "user_type",
  );
  return ident ? ident.text : null;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Declaration text with the body cut off — the one-line signature. */
function signatureOf(node: SyntaxNode, source: string): string {
  const body =
    bodyOf(node) ??
    node.namedChildren.find((c: SyntaxNode) => c.type === "function_body") ??
    null;
  const end = body ? body.startIndex : node.endIndex;
  return collapseWs(source.slice(node.startIndex, end));
}

/**
 * A name for an extension that cannot collide with the type it extends.
 *
 * `Surface+Paginating` when the extension declares conformances — the common
 * case, and stable against edits elsewhere in the file. `Surface+extension`
 * when it declares none. An ordinal only when a file holds two otherwise
 * identical extensions, and that ordinal is source-ordered: reordering two
 * bare extensions of one type in one file renames them. Stated because an
 * `api-unchanged` clause can name one of these ids.
 */
function extensionName(node: SyntaxNode, base: string, taken: Set<string>): string {
  const conformances = node.namedChildren
    .filter((c: SyntaxNode) => c.type === "inheritance_specifier")
    .map((c: SyntaxNode) => collapseWs(c.text));
  const stem = conformances.length > 0 ? `${base}+${conformances.join("&")}` : `${base}+extension`;
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}${n}`)) n += 1;
  return `${stem}${n}`;
}

function kindForKeyword(keyword: DeclKeyword | null): SymbolKind {
  return keyword === "enum" ? "enum" : "class";
}

export function extractSwift(
  relPath: string,
  root: SyntaxNode,
  source: string,
  hash: string,
  parserVersion: number,
): FileIndex {
  const symbols: SymbolInfo[] = [];
  const imports: ImportInfo[] = [];
  const calls: CallSite[] = [];
  const taken = new Set<string>();

  const push = (
    node: SyntaxNode,
    kind: SymbolKind,
    name: string,
    qualifiedName: string,
    exported: boolean,
  ): void => {
    taken.add(qualifiedName);
    symbols.push({
      id: `${relPath}#${qualifiedName}`,
      name,
      qualifiedName,
      kind,
      file: relPath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported,
      signature: signatureOf(node, source),
    });
  };

  /** Member functions of a type, qualified by the owner's name. */
  const members = (node: SyntaxNode, owner: string, exported: boolean): void => {
    const body = bodyOf(node);
    if (!body) return;
    for (const member of body.namedChildren) {
      if (member.type !== "function_declaration") continue;
      const name = nameOf(member);
      if (!name) continue;
      push(member, "method", name, `${owner}.${name}`, exported || isExported(member));
    }
  };

  for (const node of root.namedChildren) {
    switch (node.type) {
      case "import_declaration": {
        // Swift imports name a MODULE, never a path. graph.ts's
        // resolveModule only resolves relative specifiers, so these never
        // produce cross-file edges; they are recorded because they are true.
        const module = collapseWs(node.text.replace(/^\s*(@\w+\s+)?import\s+/, ""));
        if (module) imports.push({ module, names: ["*"], line: node.startPosition.row + 1 });
        break;
      }
      case "function_declaration": {
        const name = nameOf(node);
        if (name) push(node, "function", name, name, isExported(node));
        break;
      }
      case "protocol_declaration": {
        const name = nameOf(node);
        if (!name) break;
        const exported = isExported(node);
        push(node, "interface", name, name, exported);
        members(node, name, exported);
        break;
      }
      case "typealias_declaration": {
        const name = nameOf(node);
        if (name) push(node, "type", name, name, isExported(node));
        break;
      }
      case "property_declaration": {
        // Only public ones, mirroring the TypeScript extractor's rule that
        // module-internal constants are noise in a structural index.
        const name = nameOf(node);
        if (name && isExported(node)) push(node, "const", name, name, true);
        break;
      }
      case "class_declaration": {
        const keyword = declKeyword(node);
        const base = nameOf(node);
        if (!base) break;
        const exported = isExported(node);
        if (keyword === "extension") {
          const qualified = extensionName(node, base, taken);
          push(node, "class", qualified, qualified, exported);
          members(node, qualified, exported);
        } else {
          push(node, kindForKeyword(keyword), base, base, exported);
          members(node, base, exported);
        }
        break;
      }
      default:
        break;
    }
  }

  collectCalls(root, relPath, symbols, calls);

  symbols.sort((a, b) => a.id.localeCompare(b.id));
  imports.sort((a, b) => a.line - b.line || a.module.localeCompare(b.module));
  calls.sort(
    (a, b) =>
      a.line - b.line ||
      a.callerId.localeCompare(b.callerId) ||
      a.calleeName.localeCompare(b.calleeName),
  );
  return { hash, parserVersion, symbols, imports, calls };
}

/** The smallest emitted symbol whose lines contain this one. */
function enclosingId(relPath: string, symbols: SymbolInfo[], line: number): string {
  let best: SymbolInfo | null = null;
  for (const s of symbols) {
    if (s.startLine > line || s.endLine < line) continue;
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
  }
  return best ? best.id : `${relPath}#<toplevel>`;
}

function collectCalls(
  root: SyntaxNode,
  relPath: string,
  symbols: SymbolInfo[],
  out: CallSite[],
): void {
  const visit = (node: SyntaxNode): void => {
    if (node.type === "call_expression") {
      const callee = node.namedChildren[0];
      if (callee) {
        if (callee.type === "simple_identifier") {
          out.push({
            callerId: enclosingId(relPath, symbols, node.startPosition.row + 1),
            calleeName: callee.text,
            isMethod: false,
            line: node.startPosition.row + 1,
          });
        } else if (callee.type === "navigation_expression") {
          const suffix = callee.namedChildren.find(
            (c: SyntaxNode) => c.type === "navigation_suffix",
          );
          const name = suffix
            ? suffix.namedChildren.find((c: SyntaxNode) => c.type === "simple_identifier")
            : null;
          if (name) {
            out.push({
              callerId: enclosingId(relPath, symbols, node.startPosition.row + 1),
              calleeName: name.text,
              isMethod: true,
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
}
