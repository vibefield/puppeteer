import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_TINT, oklchToHex, paneHue, paneTint, projectHue, projectTint } from './project-tint.js';

describe('project tint', () => {
  it('deals hues along the golden ratio, from just past the withheld band', () => {
    // The record's wheel: #0 at 285° (258° lifted over the band), #1 a golden turn of the 333° span on.
    expect(projectHue(0)).toBeCloseTo(285, 6);
    expect(projectHue(1)).toBeCloseTo((258 + 0.6180339887498949 * 333) % 333, 6);
    const hues = Array.from({ length: 24 }, (_, seq) => projectHue(seq));
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      // Nothing lands in the 27° band around --vf-select.
      expect(hue < 238 || hue >= 265).toBe(true);
    }
    // Every prefix stays spread: no two of the first eight within 20°.
    for (let left = 0; left < 8; left += 1) {
      for (let right = left + 1; right < 8; right += 1) {
        const distance = Math.abs(hues[left]! - hues[right]!);
        expect(Math.min(distance, 360 - distance)).toBeGreaterThan(20);
      }
    }
  });

  it('runs the pane wheel parallel to the project wheel, half a turn on, off the withheld band', () => {
    const distance = (left: number, right: number): number =>
      Math.min(Math.abs(left - right), 360 - Math.abs(left - right));
    for (let seq = 0; seq < 12; seq += 1) {
      expect(distance(paneHue(seq), projectHue(seq))).toBeGreaterThan(40);
      expect(paneHue(seq) < 238 || paneHue(seq) >= 265).toBe(true);
    }
    expect(paneTint(0, DEFAULT_PROJECT_TINT.light)).toMatch(/^#[0-9a-f]{6}$/u);
    expect(paneTint(0, DEFAULT_PROJECT_TINT.light)).not.toBe(projectTint(0, DEFAULT_PROJECT_TINT.light));
  });

  it('is the same hue in both themes; only lightness moves', () => {
    const light = projectTint(0, DEFAULT_PROJECT_TINT.light);
    const dark = projectTint(0, DEFAULT_PROJECT_TINT.dark);
    expect(light).toMatch(/^#[0-9a-f]{6}$/u);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/u);
    expect(light).not.toBe(dark);
    // A stable deal: the same sequence is the same colour on every call.
    expect(projectTint(3, DEFAULT_PROJECT_TINT.light)).toBe(projectTint(3, DEFAULT_PROJECT_TINT.light));
  });

  it('converts OKLCH to sRGB hex the way the engine does, giving up chroma to fit the gamut', () => {
    expect(oklchToHex(0, 0, 0)).toBe('#000000');
    expect(oklchToHex(1, 0, 0)).toBe('#ffffff');
    // Mid grey, no chroma: every channel equal.
    const grey = oklchToHex(0.6, 0, 0);
    expect(grey.slice(1, 3)).toBe(grey.slice(3, 5));
    expect(grey.slice(3, 5)).toBe(grey.slice(5, 7));
    // A saturated colour outside sRGB comes back valid rather than clipped to a different hue.
    expect(oklchToHex(0.74, 0.4, 145)).toMatch(/^#[0-9a-f]{6}$/u);
    // Blue-ish at 285° in the light tint: more blue than red, more red than green.
    const [r, g, b] = [1, 3, 5].map((at) =>
      Number.parseInt(projectTint(0, DEFAULT_PROJECT_TINT.light).slice(at, at + 2), 16),
    );
    expect(b).toBeGreaterThan(r!);
    expect(r).toBeGreaterThan(g!);
  });
});
