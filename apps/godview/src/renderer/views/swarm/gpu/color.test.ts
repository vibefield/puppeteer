import { describe, expect, it } from 'vitest';
import { luminance, parseCssColor, resolveCssColor, withAlpha } from './color.js';

describe('parseCssColor', () => {
  it('reads the hex forms the tokens use', () => {
    expect(parseCssColor('#ff9f0a')).toEqual([1, 159 / 255, 10 / 255, 1]);
    expect(parseCssColor('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseCssColor('#00000080')).toEqual([0, 0, 0, 128 / 255]);
    expect(parseCssColor('#12345')).toBeUndefined();
  });

  it('reads rgb() and rgba() with commas or slashes', () => {
    expect(parseCssColor('rgba(0, 0, 0, 0.022)')).toEqual([0, 0, 0, 0.022]);
    expect(parseCssColor('rgb(255 255 255 / 40%)')).toEqual([1, 1, 1, 0.4]);
    expect(parseCssColor('rgb(28 28 30 / 85%)')).toEqual([28 / 255, 28 / 255, 30 / 255, 0.85]);
  });

  it('reads the engine’s color(srgb) form and transparent', () => {
    expect(parseCssColor('color(srgb 1 0.5 0 / 0.5)')).toEqual([1, 0.5, 0, 0.5]);
    expect(parseCssColor('transparent')).toEqual([0, 0, 0, 0]);
  });

  it('leaves what only the engine can resolve undefined', () => {
    expect(parseCssColor('var(--vf-orange)')).toBeUndefined();
    expect(parseCssColor('color-mix(in srgb, red 50%, transparent)')).toBeUndefined();
  });
});

describe('resolveCssColor', () => {
  it('falls back to transparent with nothing to resolve against', () => {
    expect(resolveCssColor('color-mix(in srgb, red 50%, transparent)', undefined)).toEqual([0, 0, 0, 0]);
    expect(resolveCssColor('#30d158', undefined)).toEqual([48 / 255, 209 / 255, 88 / 255, 1]);
  });
});

describe('helpers', () => {
  it('scales alpha and tells a light ground from a dark one', () => {
    expect(withAlpha([1, 1, 1, 0.5], 0.5)).toEqual([1, 1, 1, 0.25]);
    expect(luminance([1, 1, 1, 1])).toBeCloseTo(1, 6);
    expect(luminance([0.067, 0.067, 0.067, 1])).toBeLessThan(0.5);
  });
});
