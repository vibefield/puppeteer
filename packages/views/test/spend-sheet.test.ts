import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// THE SPEND VIEW'S SHEET HIDES NO WORD OF THE HERO'S CAPTION. happy-dom applies no stylesheet, so the view's own suite
// reads every word the hero renders even where a rule would hide it; this reads spend.css as text. It lives outside the
// view's folder because a view's tests import only the SDK and vitest (MV-W1), as state-light.test.ts does.

const SHEET = new URL('../src/views/spend/spend.css', import.meta.url);
/** The view's sheet, its comments aside (they name rules in prose). */
const sheet = readFileSync(SHEET, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the spend view’s stylesheet', () => {
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
