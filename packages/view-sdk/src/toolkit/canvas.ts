// A CANVAS AT THE DEVICE'S RATIO: the backing store in device pixels, the
// element in CSS pixels. Ported from the timeline's `sizeCanvas` and the
// rain's `measureCanvas`; `maxRatio` and `pixels` keep each one's numbers.

/** The display's device pixel ratio, or 1 where there is none (a worker, a fixture), capped at `max`. */
export function canvasRatio(max = Number.POSITIVE_INFINITY): number {
  const ratio = (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1;
  return Math.min(max, ratio);
}

/** What `sizeCanvas` needs of a canvas: a DOM canvas, an offscreen one with a style, or a fixture. */
export interface SizableCanvas {
  width: number;
  height: number;
  readonly style: { width: string; height: string };
}

export interface SizeCanvasOptions {
  /** A cap on the ratio: the timeline draws at most 2×. Default: none. */
  readonly maxRatio?: number | undefined;
  /** Draw at this ratio instead of the display's (fixtures, goldens). */
  readonly ratio?: number | undefined;
  /** How a fractional backing size rounds: `round` (default), or `floor`, as the rain sized its field. */
  readonly pixels?: 'round' | 'floor' | undefined;
}

export interface CanvasSizing {
  /** The element's size in CSS pixels, rounded, never below 1. */
  readonly width: number;
  readonly height: number;
  /** The ratio the backing store was sized at. */
  readonly ratio: number;
  /** The backing store, in device pixels. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** The backing store changed size, which clears it: repaint, and re-apply a 2D context's
   * `setTransform(ratio, 0, 0, ratio, 0, 0)`. Unchanged sizes are not written, so nothing is cleared. */
  readonly resized: boolean;
}

/** Sizes `canvas` to `width`×`height` CSS pixels at the device's ratio. */
export function sizeCanvas(
  canvas: SizableCanvas,
  width: number,
  height: number,
  options: SizeCanvasOptions = {},
): CanvasSizing {
  const ratio = options.ratio ?? canvasRatio(options.maxRatio);
  const toPixels = options.pixels === 'floor' ? Math.floor : Math.round;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const pixelWidth = Math.max(1, toPixels(w * ratio));
  const pixelHeight = Math.max(1, toPixels(h * ratio));
  let resized = false;
  if (canvas.width !== pixelWidth) {
    canvas.width = pixelWidth;
    resized = true;
  }
  if (canvas.height !== pixelHeight) {
    canvas.height = pixelHeight;
    resized = true;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  return { width: w, height: h, ratio, pixelWidth, pixelHeight, resized };
}

/**
 * Calls back when the display's ratio changes — a window moved between
 * displays, a page zoom — with the new ratio. Returns the stop. A media query
 * on the current resolution, re-armed at each change; nothing at all where
 * there is no `matchMedia`.
 */
export function watchDevicePixelRatio(onChange: (ratio: number) => void): () => void {
  const matchMedia = (globalThis as { matchMedia?: (query: string) => MediaQueryList }).matchMedia;
  if (typeof matchMedia !== 'function') return () => {};
  let stopped = false;
  let query: MediaQueryList | undefined;
  const arm = (): void => {
    query?.removeEventListener('change', changed);
    query = matchMedia.call(globalThis, `(resolution: ${canvasRatio()}dppx)`);
    query.addEventListener('change', changed);
  };
  function changed(): void {
    if (stopped) return;
    arm();
    onChange(canvasRatio());
  }
  arm();
  return () => {
    stopped = true;
    query?.removeEventListener('change', changed);
    query = undefined;
  };
}
