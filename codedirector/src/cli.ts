#!/usr/bin/env node
/**
 * cdir — the process entry point. The commands are in cli-main.ts.
 *
 * Code Director parses Swift with a WebAssembly grammar, and V8's
 * background optimisation of that grammar is unsafe at process exit: on
 * Node 24 the process crashes ("Fatal process out of memory: Zone", exit
 * 133), on Node 22 it stalls ~8s. V8's baseline compiler alone
 * (--liftoff-only) avoids both, but only when set at process START — set
 * later (v8.setFlagsFromString) it does not take effect on Node 24.
 *
 * So cdir always runs with it: started without it — `node cli.js`, the npm
 * bin, an MCP client's config — this entry relaunches the same command
 * with it before loading anything else, passes signals on to the relaunched
 * process and exits with its status. A relaunch costs one bare Node start
 * (~35 ms). Commands cdir runs for you (checks, the locked command) are
 * separate processes and are not affected.
 */

import { spawn } from "node:child_process";
import { WASM_STARTUP_FLAGS } from "./core/wasm-flags";

/** Set for the relaunched process only, so a relaunch can never loop. */
const RELAUNCHED = "CDIR_RELAUNCHED";

const missing = WASM_STARTUP_FLAGS.filter((f) => !process.execArgv.includes(f));

if (missing.length === 0 || process.env[RELAUNCHED] === "1") {
  // Not inherited by anything cdir starts: a cdir run inside a check (a
  // test suite that calls cdir) must make its own decision.
  delete process.env[RELAUNCHED];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./cli-main");
} else {
  const child = spawn(process.execPath, [...missing, ...process.execArgv, __filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [RELAUNCHED]: "1" },
  });
  const forward = (signal: NodeJS.Signals) => () => {
    if (!child.killed) child.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) process.on(signal, forward(signal));
  child.on("error", (e) => {
    process.stderr.write(`cdir: could not start: ${e.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      // End the same way the command did.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
