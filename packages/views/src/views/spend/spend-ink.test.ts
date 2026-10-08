import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_TINT, parseCssColor, projectColour } from '@vibecook/puppeteer-view-sdk/toolkit';
import { liftedFill, rgbToOklch, siblingIndex, siblingTone } from './spend-ink.js';

const rosetta = parseCssColor(projectColour(1, DEFAULT_PROJECT_TINT.light))!;

describe('the spend inks', () => {
  it('reads a project colour back to the theme lightness it was dealt at', () => {
    expect(rgbToOklch(rosetta).l).toBeCloseTo(DEFAULT_PROJECT_TINT.light.l, 2);
  });

  it("keeps the host's colour for the first sibling, a step darker for the second, lighter for the third (SV-D4)", () => {
    expect(siblingTone(rosetta, 0, false)).toBe(rosetta);
    const second = rgbToOklch(siblingTone(rosetta, 1, false));
    const third = rgbToOklch(siblingTone(rosetta, 2, false));
    expect(second.l).toBeCloseTo(0.5, 2);
    expect(third.l).toBeCloseTo(0.7, 2);
    expect(Math.abs(second.h - rgbToOklch(rosetta).h)).toBeLessThan(3);
  });

  it('lifts a fill light enough for dark words in either theme', () => {
    expect(rgbToOklch(parseCssColor(liftedFill(rosetta, 0))!).l).toBeCloseTo(0.83, 2);
  });

  it('deals siblings by birth within a project', () => {
    const sib = siblingIndex([
      { id: 'b', project: 'rosetta', bornMs: 2 },
      { id: 'a', project: 'rosetta', bornMs: 1 },
      { id: 'n', project: 'notes', bornMs: 3 },
      { id: 'c', project: 'rosetta', bornMs: 5 },
    ]);
    expect([sib.get('a'), sib.get('b'), sib.get('c'), sib.get('n')]).toEqual([0, 1, 2, 0]);
  });
});
