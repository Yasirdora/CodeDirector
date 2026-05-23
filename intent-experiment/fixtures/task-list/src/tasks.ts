/**
 * tasks.ts — task list core logic.
 *
 * Display order is NEWEST FIRST (id desc). `done <n>` takes the 1-based
 * index as shown by `list`.
 *
 * NOTE: completeTask below contains a subtle planted bug for the benchmark:
 * it indexes the raw insertion-ordered array instead of the displayed
 * (sorted, filtered) list, so `done 1` completes the wrong task whenever
 * two or more tasks exist.
 */

import { type Task, loadTasks, saveTasks, nextId } from "./storage.ts";

/** Tasks as the user sees them: incomplete first? No — newest first, done hidden unless all=true. */
export function visibleTasks(tasks: Task[], all = false): Task[] {
  const filtered = all ? tasks : tasks.filter((t) => !t.done);
  return [...filtered].sort((a, b) => b.id - a.id);
}

export function addTask(title: string, file?: string): Task {
  const tasks = loadTasks(file);
  const task: Task = { id: nextId(tasks), title, done: false, createdAt: new Date().toISOString() };
  tasks.push(task);
  saveTasks(tasks, file);
  return task;
}

export function listTasks(all = false, file?: string): Task[] {
  return visibleTasks(loadTasks(file), all);
}

/** Complete the task at 1-based display index n (as shown by `list`). */
export function completeTask(n: number, file?: string): Task {
  const tasks = loadTasks(file);
  // PLANTED BUG: indexes the unsorted, unfiltered array instead of visibleTasks().
  const task = tasks[n - 1];
  if (!task) throw new Error(`no task at index ${n}`);
  task.done = true;
  saveTasks(tasks, file);
  return task;
}
