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
