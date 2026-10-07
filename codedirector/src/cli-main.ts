/**
 * cdir — Code Director CLI (the commands; src/cli.ts starts the process
 * and loads this module).
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
 *   cdir checks [paths...] [--json]    The checks .codedirector/checks.yaml requires
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
import { draftLock, parseKeepClause, LOW_CONFIDENCE_FLAG, type DraftOptions } from "./lock/draft";
import { DEFAULT_VERIFY_TIMEOUT_MS } from "./lock/types";
import { getProfile, mergeDraftOptions, PROFILE_NAMES } from "./lock/profiles";
import { listLocks, loadLock, saveLock } from "./lock/store";
import { sealLock } from "./lock/seal";
import { checkLock } from "./lock/check";
import { CHECKS_FILE, checksNeededBy, joinRuns, loadChecks } from "./config/checks";
import { formatLock, formatLockLine } from "./lock/show";
import { createCheckpoint, latestCheckpoint, undo, CheckpointError } from "./checkpoint";
import { formatRunReport, runWithLock, RunError } from "./run/run";
import { ensureTaskBaseline } from "./run/run";
import { rebaseTaskBaseline } from "./run/baseline";
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
          [--verify-command CMD]            activate. SPECs: api-unchanged:<file>#<sym>,
          [--profile NAME]                  tests-pass:<glob>, output-unchanged:<cmd>,
                                            no-new-dependency, custom:<text>
          [--verify-timeout MS]             sets the lock's verifyTimeoutMs
                                            (estimated from --verify-command
                                            when omitted)
                                            --profile applies a preset bundle of draft
                                            defaults (available: ${PROFILE_NAMES.join(", ")}); explicit
                                            --deny/--keep/--budget-files ADD to the
                                            profile's values, --verify-command
                                            overrides it
  cdir lock ls [--root DIR]               List Locks
  cdir lock show <id> [--root DIR]        Render a Lock (✓ machine-checkable ·
                                          ? human judges)
  cdir lock check <id> [--root DIR]       Validate against the current index;
                                          exit 1 when invalid
  cdir lock activate <id> [--root DIR]    draft → active (requires check to pass)

  cdir checks [paths...] [--root DIR]     The checks ${CHECKS_FILE} requires.
          [--json]                        No paths: validate the file and list its
                                          checks and areas. With paths: the checks
                                          those files need, and the command that
                                          runs them. Exit 1 when the file is invalid.

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
          [--no-report] [--test-timeout MS]
                                          budget + deny, then verify every KEEP
                                          clause (structural diffs, typecheck,
                                          tests, output hashes) and emit the
                                          Change Report. Exit 0 only when the
                                          command succeeded AND no violations.
                                          --test-timeout overrides the lock's
                                          verifyTimeoutMs (estimated from the verifyCommand) for
                                          tests and verifyCommand. Without a
                                          lock id: refused (the whole point is
                                          the contract).

  cdir verify <lock-id> [--root DIR]      Re-run the verification ladder against
          [--test-timeout MS]             the latest baseline (tests, typecheck,
                                          output hashes) without re-running the
                                          change command; --test-timeout as above
  cdir report <lock-id> [--root DIR]      Render the Change Report: violations
          [--format=terminal|md|json]     first, then verified claims with
                                          evidence classes + artifact refs,
                                          then the Unchecked bucket (always
                                          visible), then asserted findings

  cdir mcp [--root DIR]                   Serve the Code Director workflow over
                                          MCP (stdio) — the supported integration
                                          path for agents (see integrations/)

  cdir hook [--root DIR]                  PreToolUse bridge for agent lifecycle
                                          hooks: reads the payload JSON from
                                          stdin, allows (exit 0, with a reminder
                                          when no Lock is active) or blocks
                                          (exit 2) edits that violate the active
                                          Lock's deny list or budget. Fails open.

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
      const profileName = flagStr(flags, "profile");
      let base: DraftOptions = {};
      if (profileName !== undefined) {
        const profile = getProfile(profileName, root);
        if (!profile) fail(`unknown profile "${profileName}" (available: ${PROFILE_NAMES.join(", ")})`, 2);
        base = profile;
      }
      const index = await indexOnDemand(root);
      const result = draftLock(root, index, utterance, mergeDraftOptions(base, {
        goal: flagStr(flags, "goal"),
        keep: keep.length > 0 ? keep : undefined,
        deny: flagList(flags, "deny"),
        budgetFiles: flagList(flags, "budget-files"),
        verifyCommand: flagStr(flags, "verify-command"),
        verifyTimeoutMs: flags.has("verify-timeout")
          ? intFlag(flags, "verify-timeout", DEFAULT_VERIFY_TIMEOUT_MS)
          : undefined,
      }));
      const lines: string[] = [];
      // Before anything else it says: the territory below may be wrong.
      if (result.confidence.low) {
        lines.push(`⚠ ${LOW_CONFIDENCE_FLAG}`);
        for (const reason of result.confidence.reasons) lines.push(`  · ${reason}`);
        lines.push(``);
      }
      lines.push(`drafted ${result.lock.id} → ${path.relative(root, result.path)}`);
      if (result.anchors.length > 0) {
        lines.push(`anchors: ${result.anchors.map((a) => a.qualifiedName).join(", ")}`);
        for (const d of result.anchorDefense) lines.push(`  · ${d.line}`);
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
      // draft → active, or re-approval of a Lock that can still run (active,
      // verified, failed) after a seal mismatch. Only abandoned is history.
      if (lock.status === "abandoned") {
        fail(`lock ${id} has status "${lock.status}" — it cannot be activated`);
      }
      const index = await indexOnDemand(root);
      const result = checkLock(root, lock, index);
      if (!result.ok) {
        for (const e of result.errors) process.stderr.write(`  ✗ ${e}\n`);
        fail(`lock ${id} failed validation — fix it and re-run \`cdir lock check ${id}\``);
      }
      lock.status = "active";
      saveLock(root, lock);
      sealLock(root, lock); // the approval seals the contract
      process.stdout.write(`${id} is now active — run inside it with \`cdir run ${id} -- <command...>\`\n`);
      return 0;
    }

    case "rebase": {
      const id = positional[1];
      if (!id) fail("lock rebase requires a lock id, e.g. cdir lock rebase IL-0001 --accept-current", 2);
      if (!flags.has("accept-current")) {
        fail(
          `lock rebase moves the task baseline to the PRESENT tree. Review \`cdir report ${id}\` ` +
            `first, then pass --accept-current to confirm that reading.`,
          2,
        );
      }
      const lock = loadLock(root, id);
      if (!lock) fail(`no such lock: ${id} (see \`cdir lock ls\`)`, 1);
      const res = await rebaseTaskBaseline(root, lock);
      process.stdout.write(
        `task baseline for ${id} moved to the present tree\n` +
          `  new:      ${path.relative(root, res.path)}\n` +
          (res.archived ? `  archived: ${path.relative(root, res.archived)}\n` : `  (no previous baseline existed)\n`) +
          `  captured: ${res.capturedAt}\n`,
      );
      return 0;
    }

    default:
      fail(`lock: unknown subcommand "${sub ?? ""}" (new · ls · show · check · activate · rebase)`, 2);
  }
}

/** `cdir checks [paths...]`: validate the rules file, or ask what some files need. */
function checksCommand(root: string, positional: string[], flags: Map<string, Array<string | true>>): number {
  const json = flags.has("json");
  const print = (text: string, data: object) => process.stdout.write(json ? stableStringify(data) : text + "\n");
  const file = loadChecks(root);
  if (file.status === "absent") {
    print(`no rules file (${CHECKS_FILE}) — no checks are required`, { status: "absent" });
    return 0;
  }
  if (file.status === "invalid") {
    if (json) process.stdout.write(stableStringify({ status: "invalid", error: file.error }));
    else process.stderr.write(`cdir: error: ${file.error}\n`);
    return 1;
  }
  const { rules } = file;
  if (positional.length === 0) {
    const lines = [`checks (${CHECKS_FILE}):`];
    for (const c of rules.checks) {
      const contains = c.match === c.run ? "" : `   [a verifyCommand must contain: ${c.match}]`;
      lines.push(`  ${c.name}: ${c.run}${contains}`);
    }
    lines.push(`areas:`);
    for (const a of rules.areas) lines.push(`  ${a.paths.join(", ")}  need  ${a.need.join(", ")}`);
    print(lines.join("\n"), { status: "rules", ...rules });
    return 0;
  }
  // Paths are root-relative, the space the rules are written in.
  const files = positional.map((p) => path.relative(root, path.resolve(root, p)).split(path.sep).join("/"));
  const needed = checksNeededBy(rules, files);
  const command = joinRuns(needed);
  const lines = needed.map((n) => `${n.check.name}: ${n.check.run}   (${n.files.join(", ")})`);
  lines.push(needed.length > 0 ? `a verifyCommand that runs them: ${command}` : `no check is needed for these paths`);
  const checks = needed.map((n) => ({ name: n.check.name, run: n.check.run, match: n.check.match, files: n.files }));
  print(lines.join("\n"), { status: "rules", needed: checks, command });
  return 0;
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

    case "checks":
      return checksCommand(root, positional, flags);

    case "checkpoint": {
      try {
        const ckpt = createCheckpoint(root);
        const lines = [
          `checkpoint ${ckpt.id}`,
          `  tag:   ${ckpt.tag}`,
          `  ref:   ${ckpt.ref.slice(0, 12)}`,
          `  tree:  ${ckpt.dirty ? "dirty (uncommitted changes present — undo will need --force)" : "clean"}`,
        ];
        // `cdir checkpoint IL-XXXX` also captures the lock's task baseline —
        // the pre-change reference for a task done by direct edits.
        const lockArg = positional[0];
        if (lockArg) {
          const lock = loadLock(root, lockArg);
          if (!lock) fail(`no such lock: ${lockArg} (see \`cdir lock ls\`)`, 1);
          if (lock.status === "draft") {
            fail(
              `lock ${lockArg} is a draft — approve it first (\`lock check\` + \`lock activate\`); ` +
                `the task baseline is captured for an approved contract`,
              1,
            );
          }
          const task = await ensureTaskBaseline(root, lock, ckpt.tag);
          lines.push(
            `  task baseline: .codedirector/baselines/${lockArg}-task.json (${task.source})` +
              (task.source === "existing" ? " — captured once; a retry reuses it" : ""),
          );
        }
        process.stdout.write(lines.join("\n") + "\n");
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

    case "mcp": {
      // Blocks until the client disconnects; stdio is the protocol channel.
      const { startMcpServer } = await import("./mcp/server");
      await startMcpServer(root);
      return 0;
    }

    case "hook": {
      // PreToolUse bridge for agent CLIs (agent lifecycle hooks, etc.):
      // payload JSON on stdin, allow/remind on exit 0, block on exit 2.
      const { runHookCommand, readStdin } = await import("./hook/index");
      const stdinText = process.stdin.isTTY ? "" : await readStdin(process.stdin);
      return runHookCommand(root, stdinText);
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
        const testTimeoutMs = flags.has("test-timeout") ? intFlag(flags, "test-timeout", 60_000) : undefined;
        const outcome = await runWithLock(root, lockId, runCommand, {
          allowExpand: flags.has("allow-expand"),
          ...(testTimeoutMs !== undefined ? { verifyOptions: { testTimeoutMs } } : {}),
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
        const testTimeoutMs = flags.has("test-timeout") ? intFlag(flags, "test-timeout", 60_000) : undefined;
        const report = await buildReport(root, lockId, testTimeoutMs !== undefined ? { testTimeoutMs } : {});
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
        const attempt = flags.has("attempt") ? intFlag(flags, "attempt", 1) : undefined;
        const report = await buildReport(root, lockId, attempt !== undefined ? { attempt } : {});
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
