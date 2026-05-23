// t06 check: endDrag must synchronously notify listeners (flush).
// Runs with cwd = final repo root.
import path from "node:path";

const { SliderBinding } = await import(path.resolve("src/slider.ts"));
const s = new SliderBinding(60000); // long debounce: only endDrag can emit in time
let emissions = 0;
s.onChange(() => emissions++);
s.beginDrag();
s.setValue(0.9);
s.endDrag();
if (emissions < 1) {
  console.error("FAIL: endDrag did not notify listeners");
  process.exit(1);
}
console.log("t06 check OK");
process.exit(0); // don't wait for the pending debounce timer
