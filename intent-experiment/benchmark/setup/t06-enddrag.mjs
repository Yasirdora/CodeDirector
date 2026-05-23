// t06 setup: simulate "the last change" — a commit that breaks drag-end
// notification by dropping the flush() call from endDrag. cwd = temp repo.
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/slider.ts";
let s = readFileSync(p, "utf8");
const before = s;
s = s.replace(
  `  endDrag(): void {
    this.state = { ...this.state, dragging: false };
    this.flush();
  }`,
  `  endDrag(): void {
    this.state = { ...this.state, dragging: false };
  }`,
);
if (s === before) throw new Error("t06 setup: endDrag pattern not found");
writeFileSync(p, s);
console.log("t06 setup applied: endDrag no longer flushes");
