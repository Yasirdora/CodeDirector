/**
 * W2: the rules file's `refresh:` commands — the generation step that makes
 * typecheck, the tests and the verifyCommand read today's output. They run
 * after the structural rung and before every after-check, take no turn, and
 * may only change ignored files.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildIndex } from "../src/core/builder";
import { CHECKS_FILE, ChecksRules, loadChecks } from "../src/config/checks";
import { draftLock } from "../src/lock/draft";
import { saveLock } from "../src/lock/store";
import { sealLock } from "../src/lock/seal";
import { VibeCheck } from "../src/lock/types";
import { runWithLock } from "../src/run/run";
import { verifyLock } from "../src/verify/verify";
import { makeGitRepo } from "./helpers";

const NODE = process.execPath;
const append = (file: string, text: string) =>
  `require("fs").appendFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`;
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const yamlList = (commands: string[]) => commands.map((c) => `  - ${JSON.stringify(c)}`).join("\n");

/** A repo whose rules file asks for `commands` (or has no rules file). */
function repoWithRefresh(commands?: string[]): string {
  const files: Record<string, string> = {
    "src/core/a.js": "export const a = 1;\n",
    ".gitignore": "out/\n",
  };
  if (commands !== undefined) files[CHECKS_FILE] = `schemaVersion: 1\nrefresh:\n${yamlList(commands)}\n`;
  return makeGitRepo(files);
}

async function activeLock(root: string, verifyCommand: string): Promise<VibeCheck> {
  const { index } = await buildIndex(root);
  const { lock } = draftLock(root, index, "tweak the core", {
    now: "2026-11-04T00:00:00.000Z",
    createdBy: "test",
    budgetFiles: ["src/core/a.js"],
    verifyCommand: "true",
  });
  lock.verifyCommand = verifyCommand;
  lock.keep = [];
  lock.deny = [];
  lock.budget = { files: ["src/core/a.js"], symbols: [], maxFiles: 1, maxLines: 400 };
  lock.status = "active";
  saveLock(root, lock);
  sealLock(root, lock);
  return lock;
}

/** A shell command that writes the ignored file the verifyCommand needs. */
const BUILD_OUT = "mkdir -p out && printf ready > out/ready";

test("checks.yaml: refresh is a list of commands", () => {
  const root = makeGitRepo({ [CHECKS_FILE]: 'schemaVersion: 1\nrefresh: ["a", "b"]\n' });
  const file = loadChecks(root);
  assert.equal(file.status, "rules");
  assert.deepEqual((file as { rules: ChecksRules }).rules.refresh, ["a", "b"]);
});

test("checks.yaml: anything but refresh as a list of non-empty strings is invalid", () => {
  for (const bad of ['refresh: "a"', 'refresh: [""]', "refresh: [1]"]) {
    const root = makeGitRepo({ [CHECKS_FILE]: `schemaVersion: 1\n${bad}\n` });
    const file = loadChecks(root);
    assert.equal(file.status, "invalid", bad);
    assert.ok((file as { error: string }).error.includes("refresh"), (file as { error: string }).error);
  }
});

test("refresh: a locked run builds the ignored output its verifyCommand reads", async () => {
  const root = repoWithRefresh([BUILD_OUT]);
  const lock = await activeLock(root, "test -f out/ready");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 0, outcome.record.violations.join("; "));
  const items = outcome.record.verification!.items;
  assert.equal(items.find((i) => i.source === "refresh")?.verdict, "held");
  assert.equal(items.find((i) => i.source === "verify-command")?.verdict, "held");

  const bare = repoWithRefresh();
  const bareLock = await activeLock(bare, "test -f out/ready");
  const failed = await runWithLock(bare, bareLock.id, [NODE, "-e", append("src/core/a.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(failed.exitCode, 1, "without the refresh the verifyCommand finds no output");
  assert.ok(
    failed.record.violations.some((v) => v.startsWith("VERIFY verify-command: verifyCommand failed")),
    failed.record.violations.join("; "),
  );
});

test("refresh: a failure fails the run, still runs the checks, and skips the rest", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdir-refresh-"));
  const count = path.join(dir, "checked");
  const later = path.join(dir, "later");
  const failCmd = `${shq(NODE)} -e ${shq("process.exit(3)")}`;
  const skipCmd = `${shq(NODE)} -e ${shq(`require("fs").writeFileSync(${JSON.stringify(later)},"x")`)}`;
  const checkCmd = `${shq(NODE)} -e ${shq(`require("fs").appendFileSync(${JSON.stringify(count)},"x")`)}`;
  const root = repoWithRefresh([failCmd, skipCmd]);
  const lock = await activeLock(root, checkCmd);

  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 1);
  assert.ok(
    outcome.record.violations.some((v) => v.startsWith(`VERIFY refresh: refresh failed (exit 3): ${failCmd}`)),
    outcome.record.violations.join("; "),
  );
  assert.equal(fs.readFileSync(count, "utf8"), "x", "the verifyCommand still ran");
  assert.equal(fs.existsSync(later), false, "the second refresh command did not run");
  const skipped = outcome.record.verification!.items.find((i) => i.subject === `refresh · ${skipCmd}`);
  assert.equal(skipped?.verdict, "unchecked");
  assert.equal(skipped?.reason, "skipped: an earlier refresh failed");
});

test("refresh: writing a tracked file is a violation that names it", async () => {
  const writeCmd = `${shq(NODE)} -e ${shq('require("fs").appendFileSync("src/core/a.js","// built")')}`;
  const root = repoWithRefresh([writeCmd]);
  const lock = await activeLock(root, "true");
  const outcome = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// run\n")], { stdio: "pipe" });
  assert.equal(outcome.exitCode, 1);
  assert.ok(
    outcome.record.violations.some((v) =>
      v.includes(
        "refresh changed src/core/a.js, which is not an ignored output — a refresh may only bring ignored outputs up to date",
      ),
    ),
    outcome.record.violations.join("; "),
  );
});

test("refresh: a standalone verify runs it too", async () => {
  const root = repoWithRefresh([BUILD_OUT]);
  const lock = await activeLock(root, "test -f out/ready");
  const first = await runWithLock(root, lock.id, [NODE, "-e", append("src/core/a.js", "// ok\n")], { stdio: "pipe" });
  assert.equal(first.exitCode, 0, first.record.violations.join("; "));
  fs.rmSync(path.join(root, "out"), { recursive: true, force: true });

  const report = await verifyLock(root, lock.id);
  assert.equal(report.items.find((i) => i.source === "refresh")?.verdict, "held");
  assert.equal(report.items.find((i) => i.source === "verify-command")?.verdict, "held");
  assert.equal(report.violations.length, 0, report.violations.join("; "));
});
