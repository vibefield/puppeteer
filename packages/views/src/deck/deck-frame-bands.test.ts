import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The frame's two capsule rows stand INSIDE the bands the pane's padding
// reserves, so no row of the terminal's grid is ever under the badge or the
// context capsule. The stylesheet is the authority; this reads it.

const css = readFileSync(fileURLToPath(new URL('../styles/deck-frame.css', import.meta.url)), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

function px(rule: string, property: string): number {
  const match = new RegExp(`\\n\\s*${property}:\\s*(\\d+(?:\\.\\d+)?)px;`).exec(rule);
  if (!match) throw new Error(`no ${property} in px`);
  return Number(match[1]);
}

function band(side: 'top' | 'bottom'): number {
  const match = new RegExp(`--vf-terminal-safe-${side}, (\\d+)px\\)`).exec(css);
  if (!match) throw new Error(`no fallback for the ${side} band`);
  return Number(match[1]);
}

describe('the pane frame stylesheet', () => {
  it('keeps the badge row inside the top band, clear of the edge', () => {
    const row = block('.vf-pane-top');
    expect(px(row, 'top')).toBeGreaterThan(0);
    expect(px(row, 'right')).toBeGreaterThan(0);
    expect(px(row, 'top') + px(row, 'height')).toBeLessThanOrEqual(band('top'));
    expect(px(block('.vf-pane-badge'), 'height')).toBe(px(row, 'height'));
  });

  it('keeps the context capsule inside the bottom band, clear of the edge', () => {
    const row = block('.vf-pane-bottom');
    expect(px(row, 'bottom')).toBeGreaterThan(0);
    expect(px(row, 'right')).toBeGreaterThan(0);
    expect(px(row, 'bottom') + px(row, 'height')).toBeLessThanOrEqual(band('bottom'));
    expect(px(block('.vf-pane-context'), 'height')).toBe(px(row, 'height'));
  });

  it("draws the meter as a short track inside the capsule, never the pane's whole edge", () => {
    const meter = block('.vf-pane-meter');
    expect(meter).toContain('position: relative');
    expect(px(meter, 'width')).toBeLessThan(100);
  });
});
