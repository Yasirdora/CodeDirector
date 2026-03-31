/**
 * SliderBinding — debounced intensity slider for the preview.
 * Emits the current intensity while dragging, coalescing rapid movements
 * so the pipeline does not re-render on every tiny movement.
 */

export interface SliderState {
  /** 0..1 */
  value: number;
  dragging: boolean;
}

export type SliderListener = (state: SliderState) => void;

export class SliderBinding {
  private state: SliderState = { value: 0.5, dragging: false };
  private listeners: SliderListener[] = [];
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(private debounceMs = 40) {}

  onChange(listener: SliderListener): void {
    this.listeners.push(listener);
  }

  beginDrag(): void {
    this.state = { ...this.state, dragging: true };
  }

  setValue(value: number): void {
    this.state = { value: clamp01(value), dragging: this.state.dragging };
    this.scheduleEmit();
  }

  endDrag(): void {
    this.state = { ...this.state, dragging: false };
    this.flush();
  }

  current(): SliderState {
    return this.state;
  }

  private scheduleEmit(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    for (const listener of this.listeners) listener(this.state);
  }
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
