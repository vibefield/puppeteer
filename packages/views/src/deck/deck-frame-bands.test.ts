import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The frame's one row stands INSIDE the band the pane's padding reserves at
// the top, so no row of the terminal's grid is ever under the badge, the
// readout, the context ring or the clock. Nothing is drawn at the foot, whose
// band is only the selected pane's corner. The stylesheet is the authority;
// this reads it.

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

  it('draws the context ring inside the top row, and nothing at the foot', () => {
    const row = block('.vf-pane-top');
    const ring = block('.vf-pane-ring');
    expect(px(ring, 'height')).toBeLessThanOrEqual(px(row, 'height'));
    expect(px(ring, 'width')).toBe(px(ring, 'height'));
    expect(css).not.toContain('.vf-pane-bottom');
    expect(css).not.toContain('.vf-pane-meter');
  });

  it("keeps a foot band as deep as the selected pane's corner, so its last row clears the rounding", () => {
    expect(band('bottom')).toBe(px(block('.vf-deck-framed .ghostty-pane.is-active'), 'border-radius'));
  });
});
