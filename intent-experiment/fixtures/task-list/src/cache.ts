/**
 * cache.ts — fast path for reads: caches the parsed task file by mtime.
 * The slow path (storage.loadTasks) re-reads and re-parses on every call.
 */

import { statSync } from "node:fs";
import { type Task, loadTasks } from "./storage.ts";

interface CacheEntry {
  file: string;
  mtimeMs: number;
  tasks: Task[];
}

let cache: CacheEntry | null = null;

export function loadTasksFast(file: string): Task[] {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.mtimeMs === mtimeMs) return cache.tasks;
    const tasks = loadTasks(file);
    cache = { file, mtimeMs, tasks };
    return tasks;
  } catch {
    return loadTasks(file);
  }
}

export function invalidateCache(): void {
  cache = null;
}
