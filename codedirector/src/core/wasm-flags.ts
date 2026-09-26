/**
 * V8 flags Code Director's WebAssembly grammars need at process start
 * (see src/cli.ts for why, and why only at start). Dependency-free: the
 * entry point reads it before loading anything else.
 */
export const WASM_STARTUP_FLAGS = ["--liftoff-only"];

/** Whether this process was started with them. */
export function hasWasmStartupFlags(): boolean {
  return WASM_STARTUP_FLAGS.every((f) => process.execArgv.includes(f));
}
