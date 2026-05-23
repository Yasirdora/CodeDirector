// t08 check: export must clamp intensity the same way at the extremes —
// exportImage(1.5) must equal exportImage(1.0), byte for byte.
// Runs with cwd = final repo root.
import path from "node:path";

const { ImagePipeline } = await import(path.resolve("src/pipeline.ts"));
const { exportImage } = await import(path.resolve("src/export.ts"));

const src = { width: 8, height: 8, pixels: new Uint8Array(64).map((_, i) => (i * 4) % 256) };
const a = exportImage(new ImagePipeline(src), 1.5);
const b = exportImage(new ImagePipeline(src), 1.0);
if (a.sha256 !== b.sha256) {
  console.error("FAIL: export(1.5) != export(1.0) — intensity not clamped");
  process.exit(1);
}
console.log("t08 check OK");
