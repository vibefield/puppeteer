import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MONITOR_SKIN } from '@vibecook/puppeteer-view-sdk';

// L18: every host defines the skin on its stage, so a view's stylesheet can read it and nothing else of the host's.
// Godview's stage sits inside `.vf-godview`, whose theme classes carry the instrument skin's colours (godview.css);
// the skin's named easings and its sans are the same in every theme, defined once on `:root` (tokens.css), which the
// stage inherits (M57, M178).

const sheet = (file: string): string =>
  readFileSync(new URL(`../styles/${file}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const godview = sheet('godview.css');
const tokens = sheet('tokens.css');

/** The declarations of the first rule whose selector list names `selector`. */
function declarationsOf(css: string, selector: string, file: string): Map<string, string> {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    const declarations = new Map<string, string>();
    for (const declaration of match[2]!.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    return declarations;
  }
  throw new Error(`no rule for ${selector} in ${file}`);
}

describe("Godview's stage", () => {
  const everyTheme = declarationsOf(tokens, ':root', 'tokens.css');
  for (const theme of ['light', 'dark'] as const) {
    it(`defines every skin name in the ${theme} theme, or once for every theme on :root (MONITOR_SKIN, L18)`, () => {
      const declared = declarationsOf(godview, `.vf-godview.theme-${theme}`, 'godview.css');
      const missing = MONITOR_SKIN.filter((name) => !declared.get(name) && !everyTheme.get(name));
      expect(missing).toEqual([]);
    });
  }

  it('finds the island easing the timeline moves on where every theme reads it (M57)', () => {
    expect(everyTheme.get('--vf-ease-island')).toBe('cubic-bezier(0.25, 1, 0.3, 1)');
  });

  it('finds the sans the spend view sets its words in where every theme reads it, under a monospace stage (M178)', () => {
    expect(everyTheme.get('--vf-font-sans')).toMatch(/sans-serif$/);
    expect(godview).toMatch(/\.vf-godview \{[^}]*font-family: ui-monospace/);
  });
});
