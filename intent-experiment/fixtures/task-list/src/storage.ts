/**
 * storage.ts — JSON file persistence for the task list.
 * Storage file path comes from TASKS_FILE env or ./tasks.json.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

export interface Task {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
}

export function storageFile(): string {
  return process.env.TASKS_FILE || "tasks.json";
}

export function loadTasks(file: string = storageFile()): Task[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8").trim();
  if (raw === "") return [];
  return JSON.parse(raw) as Task[];
}

export function saveTasks(tasks: Task[], file: string = storageFile()): void {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(tasks, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

export function nextId(tasks: Task[]): number {
  return tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
}
