import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// WHAT THE BLOOM'S FUEL RING TAKES FROM ITS SHEET. The bloom's tests render static markup and no stylesheet applies to
// it, so they pin the classes; this reads spawn-bloom.css as text for what those classes are FOR. It lives outside the
// view's folder because a view's tests import only the SDK and vitest (MV-W1), as spend-sheet.test.ts does. The look of
// a 3 px gauge is still only a real window's to prove.

const SHEET = new URL('../src/views/swarm/bloom/spawn-bloom.css', import.meta.url);
/** The bloom's sheet, its comments aside (they name rules in prose). */
const sheet = readFileSync(SHEET, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the rule whose selector is exactly `selector` (the sheet's own spelling, spaces collapsed). */
function rule(selector: string): string {
  const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const found = rules.find((each) => each[1]!.trim().replace(/\s+/g, ' ') === selector);
  expect(found, selector).toBeDefined();
  return found![2]!;
}

/** One declaration's value in a rule's body. */
function value(body: string, property: string): string | undefined {
  return new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim();
}

describe("the spawn bloom's fuel sheet", () => {
  it('draws a ring of lines: a circle takes no fill, or it is a solid disc over the glyph', () => {
    expect(value(rule('.mv-swarm .vf-bloom-fuel circle'), 'fill')).toBe('none');
  });

  it('turns a hot fill orange, and draws an old one at half', () => {
    expect(value(rule('.mv-swarm .vf-bloom-fuel-fill.is-fuel-hot'), 'stroke')).toBe(
      'color-mix(in srgb, var(--mv-swarm-orange, #ff9f0a) 88%, transparent)',
    );
    expect(value(rule('.mv-swarm .vf-bloom-fuel-fill.is-fuel-stale'), 'opacity')).toBe('0.5');
  });

  it("inverts with the targeted face: the fuel's ink is the bud's ink, and the ground once the face is the ink", () => {
    const ink = '--mv-swarm-bloom-fuel-ink';
    expect(value(rule('.mv-swarm .vf-bloom-face'), ink)).toBe('var(--mv-swarm-bloom-ink)');
    const targeted = rule(
      '.mv-swarm .vf-bloom-bud.is-hot .vf-bloom-face, .mv-swarm .vf-bloom-bud.is-path.is-hot .vf-bloom-face',
    );
    expect(value(targeted, ink)).toBe('var(--mv-swarm-bloom-ground)');
    // and every stroke draws in that ink, the hot fill's orange aside
    for (const part of ['track', 'fill', 'tick', 'thread']) {
      expect(value(rule(`.mv-swarm .vf-bloom-fuel-${part}`), 'stroke')).toContain(`var(${ink})`);
    }
  });

  // A host's drawing (`MonitorSpawnFuel.drawn`): each stroke carries its tone (`data-tone`) and its share
  // (`--mv-swarm-bloom-fuel-share`); the sheet holds the colours.
  it("draws a host's strokes as lines: a path takes no fill either", () => {
    expect(value(rule('.mv-swarm .vf-bloom-fuel path'), 'fill')).toBe('none');
  });

  it("paints a host's arcs and notches in the fuel's ink at the share each was handed, the hot ones orange", () => {
    for (const part of ['arc', 'notch']) {
      expect(value(rule(`.mv-swarm .vf-bloom-fuel-${part}`), 'stroke')).toBe(
        'color-mix(in srgb, var(--mv-swarm-bloom-fuel-ink) var(--mv-swarm-bloom-fuel-share, 64%), transparent)',
      );
      expect(value(rule(`.mv-swarm .vf-bloom-fuel-${part}[data-tone='hot']`), 'stroke')).toBe(
        'color-mix(in srgb, var(--mv-swarm-orange, #ff9f0a) var(--mv-swarm-bloom-fuel-share, 88%), transparent)',
      );
    }
  });

  it("inverts a host's strokes with the targeted face too, and leaves the host its own numbers", () => {
    for (const part of ['arc', 'notch']) {
      expect(value(rule(`.mv-swarm .vf-bloom-fuel-${part}`), 'stroke')).toContain('var(--mv-swarm-bloom-fuel-ink)');
    }
    // a sheet's declaration wins over an SVG attribute, so no rule for a host's stroke, hot or not, sets one it hands
    const selectors = ['arc', 'notch'].flatMap((part) => [
      `.mv-swarm .vf-bloom-fuel-${part}`,
      `.mv-swarm .vf-bloom-fuel-${part}[data-tone='hot']`,
    ]);
    const properties = [
      'stroke-width',
      'stroke-linecap',
      'stroke-dasharray',
      'stroke-dashoffset',
      'stroke-opacity',
      'opacity',
    ];
    for (const selector of selectors) {
      const body = rule(selector);
      for (const property of properties) {
        expect([selector, property, value(body, property)]).toEqual([selector, property, undefined]);
      }
    }
  });

  it('adds no motion of its own: no fuel rule transitions or animates', () => {
    const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((each) => each[1]!.includes('vf-bloom-fuel'));
    expect(rules.length).toBeGreaterThan(0);
    for (const each of rules) {
      const selector = each[1]!.trim().replace(/\s+/g, ' ');
      expect([selector, /\b(?:transition|animation)/.test(each[2]!)]).toEqual([selector, false]);
    }
  });
});
