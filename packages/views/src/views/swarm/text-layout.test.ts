import { describe, expect, it } from 'vitest';
import {
  chordWidth,
  fitText,
  ladderCopy,
  layoutCopy,
  legible,
  type CopyLine,
  type PlacedLine,
  type TextMeasure,
  type TextStyle,
} from './text-layout.js';

// A monospace stand-in: every character is 0.6 em wide, plus the letter spacing.
const measure: TextMeasure = (text, style) =>
  [...text].length * style.size * 0.6 + [...text].length * (style.letterSpacing ?? 0) * style.size;

const name: TextStyle = { size: 10, weight: 800 };
const label: TextStyle = { size: 10, weight: 800, transform: 'uppercase', letterSpacing: 0.1 };

describe('fitText', () => {
  it('returns the text untouched when it fits', () => {
    expect(fitText('puppeteer', name, 60, measure)).toBe('puppeteer');
  });

  it('cuts to the longest prefix plus an ellipsis', () => {
    // 6 characters × 6px = 36px: five letters and the ellipsis.
    expect(fitText('puppeteer', name, 36, measure)).toBe('puppe…');
  });

  it('applies the case transform before measuring', () => {
    expect(fitText('fable 5.1', label, 200, measure)).toBe('FABLE 5.1');
    expect(fitText('Fable 5.1 · High', { ...label, transform: 'lowercase' }, 200, measure)).toBe('fable 5.1 · high');
  });

  it('degrades to the ellipsis alone, then to nothing', () => {
    expect(fitText('puppeteer', name, 6, measure)).toBe('…');
    expect(fitText('puppeteer', name, 0, measure)).toBe('');
  });
});

describe('chordWidth', () => {
  it('is the diameter on the centre line and nothing at the rim', () => {
    expect(chordWidth(40, -5, 5)).toBeCloseTo(2 * Math.sqrt(40 * 40 - 25), 6);
    expect(chordWidth(40, 0, 0)).toBe(80);
    expect(chordWidth(40, 30, 40)).toBe(0);
  });
});

describe('layoutCopy', () => {
  const lines: CopyLine[] = [
    { key: 'name', text: 'puppeteer', style: name, opacity: 1, tone: 'ink' },
    { key: 'model', text: 'fable 5.1', style: label, opacity: 0.58, tone: 'ink', gapBefore: 3 },
  ];

  it('stacks the block around the centre with the declared gaps', () => {
    const layout = layoutCopy(lines, { radius: 40, measure, maxWidthRatio: 0.84 });
    // 10.5 + 3 + 10.5 = 24px tall, centred: top −12, bottom 12.
    expect(layout.top).toBeCloseTo(-12, 6);
    expect(layout.bottom).toBeCloseTo(12, 6);
    expect(layout.lines[0]!.y).toBeCloseTo(-12 + 5.25, 6);
    expect(layout.lines[1]!.y).toBeCloseTo(-12 + 10.5 + 3 + 5.25, 6);
    expect(layout.lines[1]!.text).toBe('FABLE 5.1');
  });

  it('fits each line to the narrower of the max width and the circle chord', () => {
    const layout = layoutCopy(
      [{ key: 'name', text: 'a very long folder name indeed', style: name, opacity: 1, tone: 'ink' }],
      { radius: 20, measure, maxWidthRatio: 0.84, inset: 2 },
    );
    const line = layout.lines[0]!;
    expect(line.text.endsWith('…')).toBe(true);
    expect(line.textWidth).toBeLessThanOrEqual(0.84 * 40);
  });

  it('gives a mark narrower than it is tall only its own width', () => {
    const measure: TextMeasure = (text) => text.length * 6;
    const line: CopyLine = {
      key: 'name',
      text: 'abc',
      style: { size: 12, weight: 800 },
      opacity: 1,
      tone: 'ink',
      // The project's folder: a 14px sprite that takes 11px of the line.
      lead: { kind: 'icon', icon: 'folder', size: 14, width: 11, gap: 4, tone: 'accent' },
    };
    const [placed] = layoutCopy([line], { radius: 60, measure, maxWidthRatio: 0.9 }).lines;
    expect(placed?.width).toBe(18 + 11 + 4);
  });

  it('reserves room for a lead mark and reports the full width', () => {
    const layout = layoutCopy(
      [{ key: 'name', text: 'jabali', style: name, opacity: 1, tone: 'ink', lead: { kind: 'dot', size: 5, gap: 4 } }],
      { radius: 40, measure, maxWidthRatio: 0.84 },
    );
    const line = layout.lines[0]!;
    expect(line.textWidth).toBe(36);
    expect(line.width).toBe(45);
  });

  it('lets a mark-only line carry just its lead', () => {
    const layout = layoutCopy(
      [
        {
          key: 'folder',
          text: '',
          style: name,
          opacity: 0.6,
          tone: 'ink',
          lead: { kind: 'icon', icon: 'folder', size: 14, gap: 0 },
        },
      ],
      { radius: 40, measure, maxWidthRatio: 0.84 },
    );
    expect(layout.lines[0]!.width).toBe(14);
  });
});

describe('legible', () => {
  const line: CopyLine = { key: 'name', text: 'puppeteer', style: name, opacity: 1, tone: 'ink' };
  const placed = (text: string): PlacedLine => ({ ...line, text, width: 0, textWidth: 0, y: 0, height: 0 });

  it('reads a whole line, and a cut that keeps three glyphs before its ellipsis', () => {
    expect(legible(placed('puppeteer'), line)).toBe(true);
    expect(legible(placed('pup…'), line)).toBe(true);
  });

  it('does not read a cut to fewer, the ellipsis alone, or nothing', () => {
    expect(legible(placed('pu…'), line)).toBe(false);
    expect(legible(placed('…'), line)).toBe(false);
    expect(legible(placed(''), line)).toBe(false);
  });

  it('asks a short line for all of itself', () => {
    const short: CopyLine = { ...line, key: 'elapsed', text: '4:39' };
    expect(legible({ ...placed('4:39'), key: 'elapsed' }, short)).toBe(true);
    expect(legible({ ...placed('4:…'), key: 'elapsed' }, short)).toBe(false);
    const two: CopyLine = { ...line, text: 'ok' };
    expect(legible(placed('o…'), two)).toBe(false);
  });

  it('compares against the line as drawn, its case transform applied', () => {
    const upper: CopyLine = { ...line, text: 'empty', style: label };
    expect(legible(placed('EMPTY'), upper)).toBe(true);
  });
});

describe('ladderCopy: the words step down', () => {
  const small: TextStyle = { size: 7, weight: 800 };
  const lines: CopyLine[] = [
    { key: 'branch', text: 'swarm-fit', style: small, opacity: 0.6, tone: 'ink' },
    { key: 'name', text: 'puppeteer', style: name, opacity: 1, tone: 'ink', gapBefore: 1 },
    { key: 'state', text: 'Allow Bash: pnpm test', style: name, opacity: 1, tone: 'ink', gapBefore: 2 },
    { key: 'model', text: 'fable 5.1 · high', style: small, opacity: 0.6, tone: 'ink', gapBefore: 3 },
  ];
  const order = ['branch', 'model', 'state'];
  const keys = (radius: number) =>
    ladderCopy(lines, { radius, measure, maxWidthRatio: 0.84, order }).lines.map((line) => line.key);

  it('lays out exactly as layoutCopy where every line reads', () => {
    expect(ladderCopy(lines, { radius: 60, measure, maxWidthRatio: 0.84, order })).toEqual(
      layoutCopy(lines, { radius: 60, measure, maxWidthRatio: 0.84 }),
    );
  });

  it('drops lines in its order, first to go first, and recentres what is left', () => {
    const seen = new Set<string>();
    for (let radius = 60; radius >= 12; radius -= 1) seen.add(keys(radius).join('+'));
    // Full, then without the branch, then the name and the state, then the name alone: never another order.
    expect([...seen]).toEqual(['branch+name+state+model', 'name+state+model', 'name+state', 'name']);
  });

  it('keeps every line it keeps legible, down to where only the name is left', () => {
    for (let radius = 60; radius >= 12; radius -= 0.5) {
      const layout = ladderCopy(lines, { radius, measure, maxWidthRatio: 0.84, order });
      const kept = layout.lines.map((placed) => lines.find((line) => line.key === placed.key)!);
      if (kept.length > 1) layout.lines.forEach((placed, index) => expect(legible(placed, kept[index]!)).toBe(true));
    }
  });

  it('never drops a line its order does not name', () => {
    expect(keys(8)).toEqual(['name']);
  });

  it('takes nothing for a name no drop could rescue', () => {
    // So wide a name is cut short even alone on the centre line: the others stay rather than go for nothing.
    const wide: CopyLine[] = [{ ...lines[1]!, style: { size: 30, weight: 800 } }, lines[3]!];
    const layout = ladderCopy(wide, { radius: 30, measure, maxWidthRatio: 0.84, order });
    expect(layout.lines.map((line) => line.key)).toEqual(['name', 'model']);
    expect(legible(layout.lines[0]!, wide[0]!)).toBe(false);
  });
});
