/**
 * PreviewView — wires the slider to the pipeline and paints preview frames.
 */

import { ImagePipeline, type PreviewFrame } from "./pipeline.ts";
import { SliderBinding, type SliderState } from "./slider.ts";

export interface Painter {
  paint(frame: PreviewFrame): void;
}

export class PreviewView {
  private pipeline: ImagePipeline;
  private slider: SliderBinding;
  private painter: Painter;
  private lastFrame: PreviewFrame | null = null;

  constructor(pipeline: ImagePipeline, slider: SliderBinding, painter: Painter) {
    this.pipeline = pipeline;
    this.slider = slider;
    this.painter = painter;
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
