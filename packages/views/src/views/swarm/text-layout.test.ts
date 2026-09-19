import { describe, expect, it } from 'vitest';
import { chordWidth, fitText, layoutCopy, type CopyLine, type TextMeasure, type TextStyle } from './text-layout.js';

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
