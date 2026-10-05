import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MONITOR_SKIN } from '@vibecook/puppeteer-view-sdk';

// L18: every host defines the skin on its stage, so a view's stylesheet can read it and nothing else of the host's.
// Godview's stage sits inside `.vf-godview`, whose theme classes carry the instrument skin (godview.css).

const css = readFileSync(new URL('../styles/godview.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list names `selector`. */
function declarationsOf(selector: string): Map<string, string> {
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
  throw new Error(`no rule for ${selector} in godview.css`);
}

describe("Godview's stage", () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`defines every skin name in the ${theme} theme (MONITOR_SKIN, L18)`, () => {
      const declared = declarationsOf(`.vf-godview.theme-${theme}`);
      const missing = MONITOR_SKIN.filter((name) => !declared.get(name));
      expect(missing).toEqual([]);
    });
  }
});
