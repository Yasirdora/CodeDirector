/**
 * exportImage — the exact, byte-stable export path.
 * Uses ImagePipeline.renderExport; the preview code never touches this.
 */

import { createHash } from "node:crypto";
import { ImagePipeline } from "./pipeline.ts";

export interface ExportResult {
  bytes: Uint8Array;
  sha256: string;
}

export function exportImage(pipeline: ImagePipeline, intensity: number): ExportResult {
  const bytes = pipeline.renderExport(intensity);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}
