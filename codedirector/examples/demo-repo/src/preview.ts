/**
 * PreviewView — wires the slider to the pipeline and paints preview frames.
 */

import { ImagePipeline, PreviewFrame } from "./pipeline";
import { SliderBinding, SliderState } from "./slider";

export interface Painter {
  paint(frame: PreviewFrame): void;
}

export class PreviewView {
  private lastFrame: PreviewFrame | null = null;

  constructor(
    private pipeline: ImagePipeline,
    private slider: SliderBinding,
    private painter: Painter,
  ) {
    this.slider.onChange((state) => this.onSlider(state));
  }

  onSlider(state: SliderState): void {
    const frame = this.pipeline.renderPreview(state.value);
    this.lastFrame = frame;
    this.painter.paint(frame);
  }

  currentFrame(): PreviewFrame | null {
    return this.lastFrame;
  }
}
