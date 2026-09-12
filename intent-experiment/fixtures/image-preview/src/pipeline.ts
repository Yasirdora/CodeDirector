/**
 * ImagePipeline — the public API an Vibe Check would pin.
 * renderPreview: fast approximate path used during drag.
 * renderExport: the exact path; its output must stay byte-identical.
 */

export interface PreviewFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface SourceImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export class ImagePipeline {
  private source: SourceImage;

  constructor(source: SourceImage) {
    this.source = source;
  }

  /** Approximate, downscaled render for interactive preview. */
  renderPreview(intensity: number, maxDim = 512): PreviewFrame {
    const scale = Math.min(1, maxDim / Math.max(this.source.width, this.source.height));
    const width = Math.max(1, Math.round(this.source.width * scale));
    const height = Math.max(1, Math.round(this.source.height * scale));
    const down = downscale(this.source, width, height);
    return { width, height, pixels: applyIntensity(down, intensity) };
  }

  /** Exact full-resolution render used by export. Byte-stable output. */
  renderExport(intensity: number): Uint8Array {
    return applyIntensity(this.source.pixels, intensity);
  }

  describe(): string {
    return `ImagePipeline(${this.source.width}x${this.source.height})`;
  }
}

export function applyIntensity(pixels: Uint8Array, intensity: number): Uint8Array {
  const out = new Uint8Array(pixels.length);
  const k = clamp01(intensity);
  for (let i = 0; i < pixels.length; i++) {
    out[i] = Math.round(pixels[i] * k);
  }
  return out;
}

export function downscale(img: SourceImage, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x / width) * img.width);
      const sy = Math.floor((y / height) * img.height);
      out[y * width + x] = img.pixels[sy * img.width + sx];
    }
  }
  return out;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
