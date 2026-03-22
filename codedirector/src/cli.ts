#!/usr/bin/env node
/**
 * cdir — Code Director CLI.
 *
 * Commands:
 *   cdir index [--root DIR]            Build/refresh the structural index
 *   cdir map <query> [options]         Ranked repo map around anchor symbols
 *   cdir why <symbol> [--json]         Blast radius for a symbol
 *   cdir help                          This help
 *
 * `map` and `why` build/refresh the index automatically on first use.
 * Exit codes: 0 success, 1 runtime failure, 2 usage error.
 */

import * as path from "node:path";
import { buildIndex } from "./core/builder";
import { buildRepoMap, formatRepoMap } from "./core/map";
import { loadIndex } from "./core/store";
import { blastRadius, formatBlastRadius } from "./core/why";
import { RepoIndex } from "./core/types";
import { stableStringify } from "./core/store";

const HELP = `cdir — Code Director: the contract/verification layer around coding agents

Usage:
  cdir index [--root DIR]                 Build or refresh the structural index
                                          (.codedirector/index.json, incremental)
  cdir map <query> [--root DIR]           Ranked repo map around symbols matching
          [--top N] [--max-tokens N]      the query (personalized PageRank)
  cdir why <symbol> [--root DIR] [--json] Blast radius: definition, callers,
                                          transitive callers, tests, co-change
  cdir help                               Show this help

Options:
  --root DIR        Repository root (default: current directory)
  --json            Machine-readable output (why)
  --top N           Max entries in map output (default 30)
  --max-tokens N    Approximate token budget for map output (default 1024)

Exit codes: 0 success · 1 failure · 2 usage error
`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function fail(message: string, code = 1): never {
  process.stderr.write(`cdir: error: ${message}\n`);
  process.exit(code);
}

function rootFrom(flags: Map<string, string | boolean>): string {
  const root = flags.get("root");
  return path.resolve(typeof root === "string" ? root : process.cwd());
}

function intFlag(flags: Map<string, string | boolean>, name: string, fallback: number): number {
  const v = flags.get(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(`--${name} must be a positive integer, got "${v}"`, 2);
  return n;
}

/** Load the index, building it on demand if missing. */
async function indexOnDemand(root: string): Promise<RepoIndex> {
  const existing = loadIndex(root);
  if (existing) {
    // Refresh incrementally so output reflects the working tree.
    const { index } = await buildIndex(root);
    return index;
  }
  process.stderr.write("cdir: no index found — building (this happens once)\n");
  const { index, stats } = await buildIndex(root);
  process.stderr.write(
    `cdir: indexed ${stats.filesTotal} files (${stats.filesParsed} parsed) in ${stats.durationMs}ms\n`,
  );
  return index;
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.has("help") || command === "help" || command === undefined) {
    process.stdout.write(HELP);
    return command === undefined && !flags.has("help") ? 2 : 0;
  }
  if (flags.has("version")) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    process.stdout.write(require("../package.json").version + "\n");
    return 0;
  }

  const root = rootFrom(flags);

  switch (command) {
    case "index": {
      const { stats } = await buildIndex(root);
      process.stdout.write(
        `Indexed ${stats.filesTotal} files: ${stats.filesParsed} parsed, ` +
          `${stats.filesUnchanged} unchanged, ${stats.filesRemoved} removed ` +
          `(${stats.durationMs}ms)\nIndex written to .codedirector/index.json\n`,
      );
      return 0;
    }

    case "map": {
      const query = positional[0];
      if (!query) fail("map requires a query, e.g. cdir map renderPreview", 2);
      const index = await indexOnDemand(root);
      const result = buildRepoMap(index, query, {
        top: intFlag(flags, "top", 30),
        maxTokens: intFlag(flags, "max-tokens", 1024),
      });
      process.stdout.write(formatRepoMap(result, query) + "\n");
      return result.anchors.length === 0 ? 1 : 0;
    }

    case "why": {
      const symbol = positional[0];
      if (!symbol) fail("why requires a symbol name, e.g. cdir why ImagePipeline.render", 2);
      const index = await indexOnDemand(root);
      const report = blastRadius(root, index, symbol);
      if (flags.has("json")) {
        process.stdout.write(stableStringify(report));
      } else {
        process.stdout.write(formatBlastRadius(report) + "\n");
      }
      return report.matches.length === 0 ? 1 : 0;
    }

    default:
      process.stderr.write(`cdir: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`cdir: error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
