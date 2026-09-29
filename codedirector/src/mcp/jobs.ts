/** MCP-only scheduling: domain runners stay synchronous inside a worker. */
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
export type Job =
  | { kind: "run_locked"; root: string; lockId: string; command: string[]; testTimeoutMs?: number }
  | { kind: "report"; root: string; lockId: string; format: string };
export type WorkerReply = { result: ToolResult } | { error: string };
const exec = promisify(execFile);

async function gitAncestor(physical: string): Promise<string | undefined> {
  for (let dir = physical; ; dir = path.dirname(dir)) {
    try {
      const entry = await stat(path.join(dir, ".git"));
      if (entry.isDirectory() || entry.isFile()) return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Without a Git executable, mapping a plain folder must still work. Walk
 * physical ancestors so even then nested projects share a worktree guard.
 * Other Git failures (permissions, unsafe ownership, timeout) fail closed.
 */
async function worktreeIdentity(root: string): Promise<string> {
  const physical = await realpath(root);
  let top: string;
  try {
    const { stdout } = await exec("git", ["-C", physical, "rev-parse", "--show-toplevel"], { timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
    top = stdout.trim();
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    const ancestor = await gitAncestor(physical);
    if (e.code === "ENOENT") return ancestor ?? physical;
    // Filesystem evidence wins over diagnostics: broken Git metadata cannot
    // turn nested paths into independent guards even if stderr changes.
    if (!ancestor && e.stderr?.includes("not a git repository (or any of the parent directories)")) return physical;
    throw e;
  }
  return realpath(top);
}

/** One guard per Git worktree, even through symlinks or project subfolders.
 * Guard ALL tools, not just workers: an already-running draft must also
 * exclude a run. This deliberately does not coordinate other MCP processes.
 */
export class WorktreeGuard {
  private owners = new Map<string, string>();

  async acquire(root: string, tool: string): Promise<() => void> {
    const canonical = await worktreeIdentity(root);
    const owner = this.owners.get(canonical);
    if (owner) throw new Error(`repository busy: ${owner} is still running; wait for completion, then request report (do not retry the command blindly)`);
    this.owners.set(canonical, tool);
    return () => { this.owners.delete(canonical); };
  }
}

/** Resolve only on worker EXIT, not its result message: no early guard
 * release. Cancellation never terminates a worker in the middle of a probe.
 * The default Worker execArgv inherits the parent's startup flags (including
 * --liftoff-only); passing that V8 flag explicitly is rejected by Node.
 */
export function runJob(job: Job, entry = path.join(__dirname, "worker.js")): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, { workerData: job, stdout: true, stderr: true });
    // Drain both pipes; neither may become protocol bytes or hold up a worker.
    worker.stdout.resume();
    worker.stderr.resume();
    let reply: WorkerReply | undefined;
    let failure: Error | undefined;
    worker.on("message", (message: WorkerReply) => { reply = message; });
    worker.on("error", (error) => { failure = error; });
    // Node guarantees all worker messages arrive before this final event.
    worker.on("exit", (code) => {
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`MCP worker exited ${code}; not verified`));
      else if (!reply) reject(new Error("MCP worker exited without a result; not verified"));
      else if ("error" in reply) reject(new Error(reply.error));
      else resolve(reply.result);
    });
  });
}
