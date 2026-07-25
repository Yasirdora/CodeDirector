import assert from "node:assert";
import test from "node:test";
import { ImagePipeline, SourceImage } from "../src/pipeline.ts";
import { exportImage } from "../src/export.ts";

function fixture(): SourceImage {
  return { width: 4, height: 4, pixels: new Uint8Array(16).map((_, i) => i * 16) };
}

test("renderExport is byte-identical for identical input", () => {
  const a = exportImage(new ImagePipeline(fixture()), 0.5);
  const b = exportImage(new ImagePipeline(fixture()), 0.5);
  assert.deepStrictEqual([...a.bytes], [...b.bytes]);
  assert.strictEqual(a.sha256, b.sha256);
});

test("renderPreview downscales to maxDim", () => {
  const pipe = new ImagePipeline({ width: 2048, height: 1024, pixels: new Uint8Array(2048 * 1024) });
  const frame = pipe.renderPreview(1, 512);
  assert.strictEqual(frame.width, 512);
  assert.strictEqual(frame.height, 256);
});
