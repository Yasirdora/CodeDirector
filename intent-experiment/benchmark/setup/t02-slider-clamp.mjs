// t02 setup: remove clamping from the slider AND add a failing test that
// pins the intended clamping behavior. cwd = temp repo root.
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/slider.ts";
let s = readFileSync(p, "utf8");
const before = s;
s = s.replace("value: clamp01(value)", "value: value");
if (s === before) throw new Error("t02 setup: pattern not found in slider.ts");
writeFileSync(p, s);

writeFileSync(
  "test/slider-clamp.test.ts",
  `import assert from "node:assert";
import test from "node:test";
import { SliderBinding } from "../src/slider.ts";

test("slider clamps value to 0..1", () => {
  const s = new SliderBinding(5);
  s.setValue(1.7);
  assert.strictEqual(s.current().value, 1);
  s.setValue(-0.3);
  assert.strictEqual(s.current().value, 0);
});
`,
);
console.log("t02 setup applied: slider clamp removed, failing test added");
