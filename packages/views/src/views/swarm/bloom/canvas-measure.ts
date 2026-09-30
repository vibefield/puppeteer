import type { BloomTextMeasure } from './constants.js';

/** The bloom's text measure in a document: a 2D canvas's advance widths in the
 * fonts `BLOOM_FONT` names (the fonts the overlay's CSS draws in), cached per
 * font and text — a bloom seats every label on every retarget. Undefined where
 * there is no canvas (a worker, a test without a DOM): the caller falls back. */
export function canvasBloomMeasure(): BloomTextMeasure | undefined {
  if (typeof document === 'undefined') return undefined;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return undefined;
  const cache = new Map<string, number>();
  let font = '';
  return (text, nextFont) => {
    const key = `${nextFont}\u0000${text}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (font !== nextFont) {
      context.font = nextFont;
      font = nextFont;
    }
    const width = context.measureText(text).width;
    if (cache.size >= 4096) cache.clear();
    cache.set(key, width);
    return width;
  };
}

/** Where no canvas can measure: characters × the font's px × 0.6 (the bloom tests' measure). */
export const approximateBloomMeasure: BloomTextMeasure = (text, font) =>
  text.length * Number(/([\d.]+)px/.exec(font)?.[1] ?? 0) * 0.6;
