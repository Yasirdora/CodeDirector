/**
 * Eval helper for `mcp: true` cases: drives one Lock through the MCP server
 * exactly as an MCP-capable agent would — lock_check, lock_activate,
 * run_locked — and maps the run result to a process exit code (1 when the
 * run comes back as an error-level result), so the eval harness can score
 * MCP-driven runs with the same expectations as CLI runs.
 *
 * Usage: node dist/eval/mcp-drive.js <root> <lockId> <shell-command>
 */

import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function textOf(r: unknown): string {
  return ((r as { content?: Array<{ text: string }> }).content ?? []).map((c) => c.text).join("\n");
}

async function main(): Promise<number> {
  const [root, lockId, shellCommand] = process.argv.slice(2);
  if (!root || !lockId || !shellCommand) {
    process.stderr.write("usage: mcp-drive <root> <lockId> <shell-command>\n");
    return 2;
  }
  const cli = path.join(__dirname, "..", "src", "cli.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--root", root],
    stderr: "inherit",
  });
  const client = new Client({ name: "cdir-eval", version: "0.0.0" });
  await client.connect(transport);
  try {
    const check = await client.callTool({ name: "lock_check", arguments: { lockId } });
    const checkInfo = JSON.parse(textOf(check));
    if (!checkInfo.ok) {
      process.stderr.write(`lock_check failed: ${(checkInfo.errors ?? []).join("; ")}\n`);
      return 2;
    }
    const act = await client.callTool({ name: "lock_activate", arguments: { lockId } });
    if ((act as { isError?: boolean }).isError) {
      process.stderr.write(`lock_activate failed: ${textOf(act)}\n`);
      return 2;
    }
    const run = await client.callTool({
      name: "run_locked",
      arguments: { lockId, command: ["sh", "-c", shellCommand] },
    });
    process.stdout.write(textOf(run) + "\n");
    return (run as { isError?: boolean }).isError ? 1 : 0;
  } finally {
    await client.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`mcp-drive: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  });
