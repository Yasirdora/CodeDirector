// t08 setup: remove the 0..1 clamp from applyIntensity so out-of-range
// intensity silently produces wrong export bytes. cwd = temp repo.
import { readFileSync, writeFileSync } from "node:fs";

const p = "src/pipeline.ts";
let s = readFileSync(p, "utf8");
const before = s;
s = s.replace("const k = clamp01(intensity);", "const k = intensity;");
if (s === before) throw new Error("t08 setup: pattern not found in pipeline.ts");
writeFileSync(p, s);
console.log("t08 setup applied: applyIntensity no longer clamps");
