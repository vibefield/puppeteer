// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { MonitorPalette as SdkPalette } from '@vibecook/puppeteer-view-sdk';
import { readMonitorPalette } from './palette.js';

const TOKENS: Readonly<Record<string, string>> = {
  '--vf-card-deep': '#000000',
  '--vf-godview-rain-green': '#4ade80',
  '--vf-godview-rain-green-focus': '#22c55e',
  '--vf-godview-rain-waiting': '#fde047',
  '--vf-godview-rain-idle': '#cbd5e1',
};

afterEach(() => {
  for (const name of Object.keys(TOKENS)) document.documentElement.style.removeProperty(name);
});

describe('the palette reader', () => {
  it('resolves the rain’s DOM colours from the rain tokens both hosts define (M46)', () => {
    for (const [name, value] of Object.entries(TOKENS)) document.documentElement.style.setProperty(name, value);
    const palette = readMonitorPalette();
    expect(palette.rain.ink).toEqual({ working: '#4ade80', blocked: '#fde047', idle: '#cbd5e1' });
    expect(palette.rain.focus).toBe('#22c55e');
    expect(palette.rain.stage).toBe('#000000');
    // The tooltip's name is the ramp's primary on the dark ground: the same white the skin's dark text-main is.
    expect(palette.text.primary).toBe('rgba(255,255,255,1)');
  });

  it('falls back to black with no tokens in the document, as every other colour does', () => {
    const palette = readMonitorPalette();
    expect(palette.rain.ink).toEqual({ working: '#000000', blocked: '#000000', idle: '#000000' });
    expect(palette.rain.focus).toBe('#000000');
  });

  it('is the SDK’s palette, with no cast (M11)', () => {
    const tokens: SdkPalette = readMonitorPalette();
    expect(tokens.rain.ink.blocked).toBe('#000000');
  });
});
