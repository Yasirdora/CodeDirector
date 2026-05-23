/**
 * cli.ts — tiny JSON task-list CLI.
 *   node src/cli.ts add "title"     → prints "added <id>. <title>"
 *   node src/cli.ts list [--all] [--json]
 *   node src/cli.ts done <n>        → prints "done <id>. <title>"
 */

import { addTask, listTasks, completeTask } from "./tasks.ts";
import { loadTasksFast } from "./cache.ts";
import { storageFile } from "./storage.ts";
import { visibleTasks } from "./tasks.ts";

function formatTask(t: { id: number; title: string; done: boolean }): string {
  return `${t.done ? "[x]" : "[ ]"} ${t.id}. ${t.title}`;
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const file = storageFile();
  switch (cmd) {
    case "add": {
      const title = rest.join(" ");
      const task = addTask(title, file);
      console.log(`added ${task.id}. ${task.title}`);
      break;
    }
    case "list": {
      const all = rest.includes("--all");
      const asJson = rest.includes("--json");
      const tasks = visibleTasks(loadTasksFast(file), all);
      if (asJson) console.log(JSON.stringify(tasks));
      else for (const t of tasks) console.log(formatTask(t));
      break;
    }
    case "done": {
      const n = parseInt(rest[0] ?? "", 10);
      const task = completeTask(n, file);
      console.log(`done ${task.id}. ${task.title}`);
      break;
    }
    default:
      console.log("usage: cli.ts add <title> | list [--all] [--json] | done <n>");
  }
}

main(process.argv.slice(2));
