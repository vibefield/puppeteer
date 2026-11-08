import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NARROW_HERO } from '../src/views/spend/spend-words.js';

// THE SPEND VIEW'S SHEET HIDES NO WORD OF THE HERO'S CAPTION. happy-dom applies no stylesheet, so the view's own suite
// reads every word the hero renders even where a rule would hide it; this reads spend.css as text. It lives outside the
// view's folder because a view's tests import only the SDK and vitest (MV-W1), as state-light.test.ts does.

const SHEET = new URL('../src/views/spend/spend.css', import.meta.url);
/** The view's sheet, its comments aside (they name rules in prose). */
const sheet = readFileSync(SHEET, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the spend view’s stylesheet', () => {
  /** The declarations of the rule whose selector is exactly `selector` (the sheet's own spelling, spaces collapsed). */
  const rule = (selector: string): string => {
    const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const found = rules.find((each) => each[1]!.trim().replace(/\s+/g, ' ') === selector);
    expect(found, selector).toBeDefined();
    return found![2]!;
  };
  /** One declaration's value in a rule's body. */
  const value = (body: string, property: string): string | undefined =>
    new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim();

  it('lays the narrow hero out as heroRoom measures it: its faces, its two gaps and the list’s inset', () => {
    const { figureFace, gapPx, rateFace, capGapPx, wordsFace, listInsetPx } = NARROW_HERO;
    // the number: light at the narrow size (its weight from the base rule, its size from the narrow one)
    const [figureWeight, figureSize] = figureFace.split(' ');
    expect(value(rule('.mv-spend .vf-monitor-spend-big'), 'font')?.startsWith(`${figureWeight} `)).toBe(true);
    const narrowFigure = rule('.mv-spend .vf-monitor-spend-hero.is-narrow .vf-monitor-spend-big');
    expect(value(narrowFigure, 'font-size')).toBe(figureSize);
    expect(value(rule('.mv-spend .vf-monitor-spend-hero.is-compact'), 'gap')).toBe(`${gapPx}px`);
    expect(value(rule('.mv-spend .vf-monitor-spend-cap b'), 'font')?.startsWith(`${rateFace}/`)).toBe(true);
    const compactCap = rule('.mv-spend .vf-monitor-spend-hero.is-compact .vf-monitor-spend-cap');
    expect(value(compactCap, 'gap')).toBe(`${capGapPx}px`);
    expect(value(rule('.mv-spend .vf-monitor-spend-cap i'), 'font')?.startsWith(`${wordsFace}/`)).toBe(true);
    expect(value(rule('.mv-spend .vf-monitor-spend-head'), 'padding')).toBe(`0 ${listInsetPx}px`);
  });

  it('hides no word of the hero’s caption at any width: a narrow stage still says who its total leaves out', () => {
    // Every rule that styles the caption's words (`.vf-monitor-spend-cap i`), with its declarations.
    const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((rule) => ({ selector: rule[1]!.trim(), body: rule[2]! }))
      .filter((rule) => /\.vf-monitor-spend-cap\s+i\b/.test(rule.selector));
    expect(rules.length).toBeGreaterThan(0);
    const hiding = rules.filter((rule) => /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/.test(rule.body));
    expect(hiding.map((rule) => rule.selector)).toEqual([]);
  });
});
