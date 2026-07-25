/** Parser extraction tests on a small inline TS sample. */

import assert from "node:assert/strict";
import test from "node:test";
import { StructuralParser } from "../src/core/parser";
import { hashContent } from "../src/core/builder";

const SAMPLE = `import { helper } from "./helper";
import * as fs from "node:fs";
import DefaultThing from "./thing";

export interface Config {
  mode: string;
}

export type Handler = (c: Config) => void;

export const MAX_RETRIES = 3;

export const makeHandler = (cfg: Config): Handler => {
  return (c) => helper(c.mode);
};

export function greet(name: string): string {
  return helper(name);
}

export class Greeter {
  greet(name: string): string {
    return helper(name);
  }
  private label(): string {
    return "greeter";
  }
}
`;

async function makeParser(): Promise<StructuralParser> {
  const p = new StructuralParser();
  await p.init();
  return p;
}

test("extracts symbols with kind, export flag, lines, signature", async () => {
  const p = await makeParser();
  const fi = p.parseFile("src/sample.ts", SAMPLE, hashContent(SAMPLE));
  const byId = new Map(fi.symbols.map((s) => [s.id, s]));

  const config = byId.get("src/sample.ts#Config");
  assert.ok(config, "Config interface extracted");
  assert.equal(config.kind, "interface");
  assert.equal(config.exported, true);
  assert.equal(config.startLine, 5);
  assert.equal(config.endLine, 7);

  const handler = byId.get("src/sample.ts#Handler");
  assert.equal(handler?.kind, "type");

  const maxRetries = byId.get("src/sample.ts#MAX_RETRIES");
  assert.ok(maxRetries, "exported const extracted");
  assert.equal(maxRetries.kind, "const");
  assert.equal(maxRetries.exported, true);

  const makeHandler = byId.get("src/sample.ts#makeHandler");
  assert.ok(makeHandler, "exported arrow-function const extracted");
  assert.equal(makeHandler.kind, "const");

  const greet = byId.get("src/sample.ts#greet");
  assert.equal(greet?.kind, "function");
  assert.equal(greet?.signature, "function greet(name: string): string");

  const greeter = byId.get("src/sample.ts#Greeter");
  assert.equal(greeter?.kind, "class");

  const method = byId.get("src/sample.ts#Greeter.greet");
  assert.ok(method, "method extracted with qualified name");
  assert.equal(method.kind, "method");

  const priv = byId.get("src/sample.ts#Greeter.label");
  assert.ok(priv, "private method extracted");
  assert.equal(priv.exported, true, "methods inherit the (exported) class's export flag");
});

test("extracts imports with module and names", async () => {
  const p = await makeParser();
  const fi = p.parseFile("src/sample.ts", SAMPLE, hashContent(SAMPLE));
  assert.equal(fi.imports.length, 3);
  const helper = fi.imports.find((i) => i.module === "./helper");
  assert.deepEqual(helper?.names, ["helper"]);
  const fsImp = fi.imports.find((i) => i.module === "node:fs");
  assert.deepEqual(fsImp?.names, ["*"]);
  const def = fi.imports.find((i) => i.module === "./thing");
  assert.deepEqual(def?.names, ["default:DefaultThing"]);
});

test("extracts call sites attributed to enclosing symbol", async () => {
  const p = await makeParser();
  const fi = p.parseFile("src/sample.ts", SAMPLE, hashContent(SAMPLE));
  const helperCalls = fi.calls.filter((c) => c.calleeName === "helper");
  const callers = new Set(helperCalls.map((c) => c.callerId));
  assert.ok(callers.has("src/sample.ts#greet"), "call inside greet attributed");
  assert.ok(callers.has("src/sample.ts#Greeter.greet"), "call inside method attributed");
  assert.ok(callers.has("src/sample.ts#makeHandler"), "call inside arrow const attributed");
});

test("arrow-function consts: signature includes type params, params, return type", async () => {
  const p = await makeParser();
  const src = `export const compose = <E>(a: E, b: E): E => {
  return b;
};

export const fetchAll = async (id: string, opts?: { raw: boolean }, retries = 3): Promise<void> => {
  return;
};

export const plain = (x) => x + 1;

export const LIMIT = 42;
`;
  const fi = p.parseFile("src/fn.ts", src, hashContent(src));
  const byId = new Map(fi.symbols.map((s) => [s.id, s]));

  const compose = byId.get("src/fn.ts#compose");
  assert.ok(compose, "generic arrow const extracted");
  assert.equal(
    compose!.signature,
    "compose = <E>(a: E, b: E): E",
    `type params + params + return type in signature, got: ${compose!.signature}`,
  );

  const fetchAll = byId.get("src/fn.ts#fetchAll");
  assert.equal(
    fetchAll!.signature,
    "fetchAll = async (id: string, opts?: { raw: boolean }, retries = 3): Promise<void>",
    `async + optional + default params in signature, got: ${fetchAll!.signature}`,
  );

  const plain = byId.get("src/fn.ts#plain");
  assert.equal(plain!.signature, "plain = (x)", `expression-body arrow cut at body, got: ${plain!.signature}`);

  // plain value const: value excluded from the signature
  const limit = byId.get("src/fn.ts#LIMIT");
  assert.equal(limit!.signature, "LIMIT", `plain const signature excludes the value, got: ${limit!.signature}`);
});

test("arrow-function consts: adding a parameter CHANGES the signature hash (field-reported defect)", async () => {
  const p = await makeParser();
  const before = `export const compose = <E>(a: E, b: E): E => b;\n`;
  const after = `export const compose = <E>(a: E, b: E, c: E): E => c;\n`;
  const sigOf = (src: string) =>
    p.parseFile("src/fn.ts", src, hashContent(src)).symbols.find((s) => s.name === "compose")!.signature;
  const sigBefore = sigOf(before);
  const sigAfter = sigOf(after);
  assert.notEqual(sigBefore, sigAfter, "parameter added → signature differs");
  assert.notEqual(
    hashContent(sigBefore),
    hashContent(sigAfter),
    "parameter added → sha256 differs (no false 'signature unchanged')",
  );
});

test("plain const: changing only the VALUE keeps the signature stable", async () => {
  const p = await makeParser();
  const sigOf = (src: string) =>
    p.parseFile("src/fn.ts", src, hashContent(src)).symbols.find((s) => s.name === "LIMIT")!.signature;
  const a = sigOf(`export const LIMIT = 42;\n`);
  const b = sigOf(`export const LIMIT = 100;\n`);
  assert.equal(a, b, "value-only change → same signature");
  // but an arrow body change behaves like function bodies: excluded too
  const bodyOf = (src: string) =>
    p.parseFile("src/fn.ts", src, hashContent(src)).symbols.find((s) => s.name === "f")!.signature;
  assert.equal(bodyOf(`export const f = (x) => x + 1;\n`), bodyOf(`export const f = (x) => x + 2;\n`));
});

test("interface/type/enum signatures include members (api-unchanged must see them)", async () => {
  const p = await makeParser();
  const sig = (src: string, name: string) =>
    p.parseFile("x.ts", src, hashContent(src)).symbols.find((s) => s.name === name)!.signature;
  assert.notEqual(
    sig("export interface I { a: string }\n", "I"),
    sig("export interface I { a: string; b: number }\n", "I"),
  );
  assert.notEqual(
    sig("export type H = (a: string) => void;\n", "H"),
    sig("export type H = (a: string, b: number) => void;\n", "H"),
  );
  assert.notEqual(sig("export enum E { A = 1 }\n", "E"), sig("export enum E { A = 1, B = 2 }\n", "E"));
});

test("long function signatures are not truncated for hashing", async () => {
  const p = await makeParser();
  const params = Array.from({ length: 40 }, (_, i) => `p${i}: number`).join(", ");
  const a = p.parseFile("x.ts", `export function f(${params}): void {}\n`, "a").symbols[0].signature;
  const b = p.parseFile("x.ts", `export function f(${params}, extra: boolean): void {}\n`, "b").symbols[0]
    .signature;
  assert.ok(a.length > 200, `full signature kept (${a.length} chars)`);
  assert.notEqual(a, b, "parameter past 200 chars still changes the signature");
});

test("export { name } marks the local symbol exported", async () => {
  const p = await makeParser();
  const fi = p.parseFile("x.ts", "function inner() {}\nexport { inner };\n", "h");
  const inner = fi.symbols.find((s) => s.name === "inner");
  assert.ok(inner);
  assert.equal(inner!.exported, true);
});
