#!/usr/bin/env node
/**
 * cdir — Code Director CLI.
 *
 * Commands:
 *   cdir index [--root DIR]            Build/refresh the structural index
 *   cdir map <query> [options]         Ranked repo map around anchor symbols
 *   cdir why <symbol> [--json]         Blast radius for a symbol
 *   cdir lock new "<utterance>" [...]  Draft an Vibe Check (status: draft)
 *   cdir lock ls                       List Locks
 *   cdir lock show <id>                Render a Lock with checkability markers
 *   cdir lock check <id>               Validate a Lock (non-zero exit on invalid)
 *   cdir lock activate <id>            draft → active (only if check passes)
 *   cdir checkpoint                    Git checkpoint (tag + dirty-state record)
 *   cdir undo [--force] [--keep-untracked]
 *                                       Restore the latest checkpoint
 *   cdir run <lock-id> -- <cmd...>     Verified execution inside the Lock
 *   cdir verify <lock-id>              Re-run the verification ladder
 *   cdir report <lock-id> [--format]   Change Report (terminal · md · json)
 *   cdir help                          This help
 *
 * Exit codes: 0 success, 1 runtime failure, 2 usage error.
 */

import * as path from "node:path";
import { buildIndex } from "./core/builder";
import { buildRepoMap, formatRepoMap } from "./core/map";
import { loadIndex } from "./core/store";
import { blastRadius, formatBlastRadius } from "./core/why";
import { RepoIndex } from "./core/types";
import { stableStringify } from "./core/store";
import { draftLock, parseKeepClause } from "./lock/draft";
import { listLocks, loadLock, saveLock } from "./lock/store";
import { checkLock } from "./lock/check";
import { formatLock, formatLockLine } from "./lock/show";
import { createCheckpoint, latestCheckpoint, undo, CheckpointError } from "./checkpoint";
import { formatRunReport, runWithLock, RunError } from "./run/run";
import { VerifyError } from "./verify/verify";
import { buildReport, finalizeLockStatus, ReportError } from "./report/report";
import { formatReport, formatReportJson, formatReportMarkdown } from "./report/format";

const HELP = `cdir — Code Director: the contract/verification layer around coding agents

Usage:
  cdir index [--root DIR]                 Build or refresh the structural index
                                          (.codedirector/index.json, incremental)
  cdir map <query> [--root DIR]           Ranked repo map around symbols matching
          [--top N] [--max-tokens N]      the query (personalized PageRank)
  cdir why <symbol> [--root DIR] [--json] Blast radius: definition, callers,
                                          transitive callers, tests, co-change

  cdir lock new "<utterance>" [--root DIR]  Draft an Vibe Check from your words:
          [--goal TEXT] [--keep SPEC]       anchors + blast radius propose the
          [--deny GLOB] [--budget-files F]  budget and deny list; you edit, then
                                          activate. SPECs: api-unchanged:<file>#<sym>,
                                          tests-pass:<glob>, output-unchanged:<cmd>,
                                          no-new-dependency, custom:<text>
  cdir lock ls [--root DIR]               List Locks
  cdir lock show <id> [--root DIR]        Render a Lock (✓ machine-checkable ·
                                          ? human judges)
  cdir lock check <id> [--root DIR]       Validate against the current index;
                                          exit 1 when invalid
  cdir lock activate <id> [--root DIR]    draft → active (requires check to pass)

  cdir checkpoint [--root DIR]            Git checkpoint: tag cdir/ckpt-<ts> at
                                          HEAD + record dirty state
  cdir undo [--root DIR] [--force]        Restore the latest checkpoint. Refuses
          [--keep-untracked]              when the checkpoint covered a dirty
                                          tree, unless --force (says what is lost).
                                          Untracked files created after the
                                          checkpoint are DELETED (listed first);
                                          --keep-untracked preserves them.

  cdir run <lock-id> [--root DIR]         Verified execution: checkpoint, capture
          [--allow-expand] -- <cmd...>    baseline, run the command, enforce
          [--no-report]                   budget + deny, then verify every KEEP
                                          clause (structural diffs, typecheck,
                                          tests, output hashes) and emit the
                                          Change Report. Exit 0 only when the
                                          command succeeded AND no violations.
                                          Without a lock id: refused (the whole
                                          point is the contract).

  cdir verify <lock-id> [--root DIR]      Re-run the verification ladder against
                                          the latest baseline (tests, typecheck,
                                          output hashes) without re-running the
                                          change command
  cdir report <lock-id> [--root DIR]      Render the Change Report: violations
          [--format=terminal|md|json]     first, then verified claims with
                                          evidence classes + artifact refs,
                                          then the Unchecked bucket (always
                                          visible), then asserted findings

  cdir help                               Show this help

Options:
  --root DIR        Repository root (default: current directory)
  --json            Machine-readable output (why)
  --format FMT      Report format: terminal (default), md, json
  --top N           Max entries in map output (default 30)
  --max-tokens N    Approximate token budget for map output (default 1024)

Exit codes: 0 success · 1 failure · 2 usage error
`;

/** Flags may repeat (--keep, --deny, --budget-files); values are collected. */
interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, Array<string | true>>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, Array<string | true>>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        // --key=value form
        const key = arg.slice(2, eq);
        const list = flags.get(key) ?? [];
        list.push(arg.slice(eq + 1));
        flags.set(key, list);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      const value: string | true = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
      const list = flags.get(key) ?? [];
      list.push(value);
      flags.set(key, list);
    } else if (command === undefined) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function flagStr(flags: Map<string, Array<string | true>>, name: string): string | undefined {
  const v = flags.get(name)?.[0];
  return typeof v === "string" ? v : undefined;
}

/** All values of a repeatable flag, comma-split, flattened. */
function flagList(flags: Map<string, Array<string | true>>, name: string): string[] {
  const out: string[] = [];
  for (const v of flags.get(name) ?? []) {
    if (typeof v !== "string") continue;
    for (const part of v.split(",")) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`cdir: error: ${message}\n`);
  process.exit(code);
}

function renderReport(report: import("./report/report").ChangeReport, fmt: string): string {
  switch (fmt) {
    case "terminal":
    case "text":
      return formatReport(report);
    case "md":
    case "markdown":
      return formatReportMarkdown(report);
    case "json":
      return formatReportJson(report);
    default:
      fail(`unknown report format "${fmt}" (terminal · md · json)`, 2);
  }
}

function rootFrom(flags: Map<string, Array<string | true>>): string {
  return path.resolve(flagStr(flags, "root") ?? process.cwd());
}

function intFlag(flags: Map<string, Array<string | true>>, name: string, fallback: number): number {
  const v = flagStr(flags, name);
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

async function lockCommand(root: string, positional: string[], flags: Map<string, Array<string | true>>): Promise<number> {
  const sub = positional[0];
  switch (sub) {
    case "new": {
      const utterance = positional[1];
      if (!utterance) fail('lock new requires the user\'s words, e.g. cdir lock new "make the preview feel instant"', 2);
      const keep = [];
      for (const spec of flagList(flags, "keep")) {
        try {
          keep.push(parseKeepClause(spec));
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e), 2);
        }
      }
      const index = await indexOnDemand(root);
      const result = draftLock(root, index, utterance, {
        goal: flagStr(flags, "goal"),
        keep: keep.length > 0 ? keep : undefined,
        deny: flagList(flags, "deny"),
        budgetFiles: flagList(flags, "budget-files"),
        verifyCommand: flagStr(flags, "verify-command"),
      });
      const lines: string[] = [];
      lines.push(`drafted ${result.lock.id} → ${path.relative(root, result.path)}`);
      if (result.anchors.length > 0) {
        lines.push(`anchors: ${result.anchors.map((a) => a.qualifiedName).join(", ")}`);
        if (result.anchorStrength === "lexical") {
          lines.push(`proposed budget: (none — weak lexical anchors only; name files with --budget-files)`);
        } else {
          lines.push(`proposed budget: ${result.proposedFiles.join(", ") || "(none)"}`);
        }
      } else {
        lines.push(`anchors: none matched — budget left empty, fill it in by hand`);
      }
      if (result.suggestedDeny.length > 0) {
        lines.push(`suggested deny: ${result.suggestedDeny.join(", ")}`);
        if (result.denyOmitted > 0) {
          lines.push(`  (+${result.denyOmitted} more omitted for readability — see the lock's assumptions)`);
        }
      }
      lines.push(``, `next: edit the file, then \`cdir lock check ${result.lock.id}\` and \`cdir lock activate ${result.lock.id}\``);
      process.stdout.write(lines.join("\n") + "\n");
      return 0;
    }

    case "ls": {
      const locks = listLocks(root);
      if (locks.length === 0) {
        process.stdout.write(`no locks yet — draft one with \`cdir lock new "<what you want>"\`\n`);
        return 0;
      }
      process.stdout.write(locks.map(formatLockLine).join("\n") + "\n");
      return 0;
    }

    case "show": {
      const id = positional[1];
      if (!id) fail("lock show requires an id, e.g. cdir lock show IL-0001", 2);
      const lock = loadLock(root, id);
      if (!lock) fail(`no such lock: ${id}`);
      const index = loadIndex(root);
      const check = checkLock(root, lock, index);
      process.stdout.write(formatLock(lock, check) + "\n");
      return 0;
    }

    case "check": {
      const id = positional[1];
      if (!id) fail("lock check requires an id, e.g. cdir lock check IL-0001", 2);
      const lock = loadLock(root, id);
      if (!lock) fail(`no such lock: ${id}`);
      const index = await indexOnDemand(root);
      const result = checkLock(root, lock, index);
      const lines: string[] = [];
      for (const e of result.errors) lines.push(`  ✗ ${e}`);
      for (const w of result.warnings) lines.push(`  ! ${w}`);
      lines.push(result.ok ? `${id}: valid` : `${id}: INVALID (${result.errors.length} error(s))`);
      process.stdout.write(lines.join("\n") + "\n");
      return result.ok ? 0 : 1;
    }

    case "activate": {
      const id = positional[1];
      if (!id) fail("lock activate requires an id, e.g. cdir lock activate IL-0001", 2);
      const lock = loadLock(root, id);
      if (!lock) fail(`no such lock: ${id}`);
      if (lock.status !== "draft") fail(`lock ${id} has status "${lock.status}" — only drafts can be activated`);
      const index = await indexOnDemand(root);
      const result = checkLock(root, lock, index);
      if (!result.ok) {
        for (const e of result.errors) process.stderr.write(`  ✗ ${e}\n`);
        fail(`lock ${id} failed validation — fix it and re-run \`cdir lock check ${id}\``);
      }
      lock.status = "active";
      saveLock(root, lock);
      process.stdout.write(`${id} is now active — run inside it with \`cdir run ${id} -- <command...>\`\n`);
      return 0;
    }

    default:
      fail(`lock: unknown subcommand "${sub ?? ""}" (new · ls · show · check · activate)`, 2);
  }
}

async function main(): Promise<number> {
  // Everything after a bare `--` is the command for `cdir run`.
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const runCommand = sep === -1 ? null : argv.slice(sep + 1);
  const { command, positional, flags } = parseArgs(sep === -1 ? argv : argv.slice(0, sep));

  if (flags.has("version")) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    process.stdout.write(require("../../package.json").version + "\n");
    return 0;
  }
  if (flags.has("help") || command === "help" || command === undefined) {
    process.stdout.write(HELP);
    return command === undefined && !flags.has("help") ? 2 : 0;
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

    case "lock":
      return lockCommand(root, positional, flags);

    case "checkpoint": {
      try {
        const ckpt = createCheckpoint(root);
        process.stdout.write(
          `checkpoint ${ckpt.id}\n  tag:   ${ckpt.tag}\n  ref:   ${ckpt.ref.slice(0, 12)}\n` +
            `  tree:  ${ckpt.dirty ? "dirty (uncommitted changes present — undo will need --force)" : "clean"}\n`,
        );
        return 0;
      } catch (e) {
        if (e instanceof CheckpointError) fail(e.message);
        throw e;
      }
    }

    case "undo": {
      try {
        const prev = latestCheckpoint(root);
        const result = undo(root, { force: flags.has("force"), keepUntracked: flags.has("keep-untracked") });
        const lines = [
          `restored ${result.checkpoint.tag} (${result.checkpoint.ref.slice(0, 12)})`,
        ];
        if (result.lostFiles.length > 0) {
          lines.push(`discarded uncommitted changes in:`);
          for (const f of result.lostFiles) lines.push(`  ${f}`);
        }
        if (result.deletedUntracked.length > 0) {
          lines.push(`deleted untracked files created after the checkpoint (--keep-untracked preserves them):`);
          for (const f of result.deletedUntracked) lines.push(`  ${f}`);
        }
        if (result.untrackedRemaining.length > 0) {
          lines.push(`note: untracked files left in place:`);
          for (const f of result.untrackedRemaining) lines.push(`  ${f}`);
        }
        if (!prev) lines.push(`note: no earlier checkpoints remain`);
        process.stdout.write(lines.join("\n") + "\n");
        return 0;
      } catch (e) {
        if (e instanceof CheckpointError) fail(e.message);
        throw e;
      }
    }

    case "run": {
      const lockId = positional[0];
      if (!lockId) {
        process.stderr.write(
          `cdir: error: run requires a lock id — ad-hoc execution is a later phase by design;\n` +
            `  the whole point is the contract. Draft one first:\n` +
            `    cdir lock new "<what you want>"\n` +
            `    cdir lock activate IL-0001\n` +
            `    cdir run IL-0001 -- <command...>\n`,
        );
        return 2;
      }
      if (!runCommand || runCommand.length === 0) {
        fail(`run requires a command after "--", e.g. cdir run ${lockId} -- npm test`, 2);
      }
      try {
        const outcome = await runWithLock(root, lockId, runCommand, {
          allowExpand: flags.has("allow-expand"),
        });
        process.stdout.write(formatRunReport(outcome) + "\n");
        // The Change Report is auto-emitted at the end of every run.
        if (!flags.has("no-report")) {
          const report = await buildReport(root, lockId, {
            verification: outcome.record.verification,
            run: outcome.record,
            runRecordPath: outcome.recordPath,
          });
          const fmt = flagStr(flags, "format") ?? "terminal";
          process.stdout.write("\n" + renderReport(report, fmt) + "\n");
        }
        return outcome.exitCode;
      } catch (e) {
        if (e instanceof RunError || e instanceof CheckpointError) fail(e.message);
        throw e;
      }
    }

    case "verify": {
      const lockId = positional[0];
      if (!lockId) fail("verify requires a lock id, e.g. cdir verify IL-0001", 2);
      try {
        const report = await buildReport(root, lockId);
        finalizeLockStatus(root, report);
        const fmt = flagStr(flags, "format") ?? "terminal";
        process.stdout.write(renderReport(report, fmt) + "\n");
        return report.verdict === "verified" ? 0 : 1;
      } catch (e) {
        if (e instanceof VerifyError || e instanceof ReportError) fail(e.message);
        throw e;
      }
    }

    case "report": {
      const lockId = positional[0];
      if (!lockId) fail("report requires a lock id, e.g. cdir report IL-0001", 2);
      try {
        const report = await buildReport(root, lockId);
        finalizeLockStatus(root, report);
        const fmt = flagStr(flags, "format") ?? "terminal";
        process.stdout.write(renderReport(report, fmt) + "\n");
        return report.verdict === "verified" ? 0 : 1;
      } catch (e) {
        if (e instanceof VerifyError || e instanceof ReportError) fail(e.message);
        throw e;
      }
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
