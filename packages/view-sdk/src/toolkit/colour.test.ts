import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_TINT,
  hexToRgb255,
  oklchToHex,
  paneColour,
  projectColour,
  projectColourFor,
  projectHue,
} from './colour.js';

describe('project colour', () => {
  it('deals hues along the golden ratio, skipping the selection band', () => {
    expect(projectHue(0)).toBe(285);
    for (let seq = 0; seq < 500; seq += 1) {
      const hue = projectHue(seq);
      expect(hue < 238 || hue >= 265).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('turns a sequence into the same hex in every place', () => {
    expect(projectColour(0, DEFAULT_PROJECT_TINT.light)).toBe('#7970d5');
    expect(projectColour(0, DEFAULT_PROJECT_TINT.dark)).toBe('#a29dff');
    expect(projectColour(1, DEFAULT_PROJECT_TINT.light)).toBe('#60911f');
    expect(paneColour(0, DEFAULT_PROJECT_TINT.light)).toBe('#ca564b');
  });

  it('gives up chroma, never hue, for a colour sRGB cannot reach', () => {
    expect(oklchToHex(0.9, 0.4, 145)).toMatch(/^#[0-9a-f]{6}$/);
    expect(oklchToHex(0, 0, 0)).toBe('#000000');
  });
});

describe("the theme's colour function (L7)", () => {
  const palette = { tint: DEFAULT_PROJECT_TINT.light, neutral: 'rgba(255, 255, 255, 0.4)' };

  it('wears the neutral ramp for a row in no project', () => {
    expect(projectColourFor(palette)(undefined)).toBe(palette.neutral);
  });

  it("deals a project its colour under the theme's tint", () => {
    const colourFor = projectColourFor(palette);
    expect(colourFor(0)).toBe(projectColour(0, palette.tint));
    expect(colourFor(7)).toBe(projectColour(7, palette.tint));
  });

  it("keeps the tint it was made with, so a host rebuilds it when the theme's key changes", () => {
    const tint = { l: 0.6, c: 0.15 };
    const colourFor = projectColourFor({ tint, neutral: 'grey' });
    tint.l = 0.74;
    expect(colourFor(3)).toBe(projectColour(3, { l: 0.6, c: 0.15 }));
    expect(projectColourFor({ tint, neutral: 'grey' })(3)).toBe(projectColour(3, { l: 0.74, c: 0.15 }));
  });
});

describe('canvas channels', () => {
  it('splits a hex into r, g, b', () => {
    expect(hexToRgb255('#ff8800')).toBe('255, 136, 0');
    expect(hexToRgb255('#f80')).toBe('255, 136, 0');
    expect(hexToRgb255('rgba(1, 2, 3, 1)')).toBe('0, 0, 0');
  });
});
