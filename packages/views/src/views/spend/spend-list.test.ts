import { describe, expect, it } from 'vitest';
import { bySpend, fitList, listOrder, moreWords } from './spend-list.js';

const entries = [
  { id: 'a', value: 5, bornMs: 3 },
  { id: 'b', value: 62, bornMs: 1 },
  { id: 'c', value: 22, bornMs: 9 },
  { id: 'd', value: 22, bornMs: 2 },
];

describe('the watchlist', () => {
  it('runs most spent first, the elder first on a tie (SV-D12)', () => {
    expect(bySpend(entries)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('holds the order it showed while the pointer is on it', () => {
    expect(listOrder(entries, { held: ['a', 'c', 'b', 'd'] })).toEqual(['a', 'c', 'b', 'd']);
    // A row that arrived meanwhile goes to the end rather than moving the rest.
    expect(listOrder([...entries, { id: 'e', value: 99, bornMs: 0 }], { held: ['a', 'c', 'b', 'd'] }).at(-1)).toBe('e');
  });

  it("holds now's order while scrubbing, or sinks the unstarted, or ranks by then (SV-D16)", () => {
    const valueAt = (id: string): number | undefined => ({ a: 4, b: 1, c: undefined, d: 2 })[id];
    const scrub = (order: 'hold' | 'sink' | 'rank') => ({ t: 5, order, valueAt });
    expect(listOrder(entries, { scrub: scrub('hold') })).toEqual(['b', 'd', 'c', 'a']);
    expect(listOrder(entries, { scrub: scrub('sink') })).toEqual(['b', 'd', 'a', 'c']);
    expect(listOrder(entries, { scrub: scrub('rank') })).toEqual(['a', 'd', 'b', 'c']);
  });

  it('shows every row when they fit, with no more row', () => {
    const fit = fitList(['a', 'b', 'c'], 5, 0, new Map());
    expect(fit).toMatchObject({ fits: 3, more: false, docked: [] });
  });

  it('docks at most a third of the list, the longest wait first, and counts the rest (SV-D19)', () => {
    const order = Array.from({ length: 20 }, (_, i) => `r${i}`);
    const waiting = new Map([
      ['r9', 300],
      ['r12', 100],
      ['r15', 200],
      ['r1', 50],
    ]);
    const fit = fitList(order, 7, 0, waiting);
    expect(fit.docked).toEqual(['r12', 'r15']);
    expect(fit.fits).toBe(4);
    expect(fit.waitingUnshown).toBe(1);
    expect(fit.more).toBe(true);
    expect(moreWords(fit)).toBe('14 more below · scroll');
  });

  it('settles the dock: a docked row that shortens the sequence can leave another waiting row out, and the list never overflows', () => {
    // Nine rows in seven slots: docking g shortens the sequence, which leaves f out as well.
    const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const fit = fitList(
      order,
      7,
      0,
      new Map([
        ['f', 200],
        ['g', 100],
      ]),
    );
    expect(fit.docked).toEqual(['g', 'f']);
    expect(fit.fits).toBe(4);
    expect(fit.fits + fit.docked.length + (fit.more ? 1 : 0)).toBeLessThanOrEqual(7);
    expect(moreWords(fit)).toBe('3 more below · scroll');
  });

  it('scrolls by whole rows and says what is above', () => {
    const order = Array.from({ length: 10 }, (_, i) => `r${i}`);
    const fit = fitList(order, 4, 99, new Map());
    expect(fit.offset).toBe(fit.maxOffset);
    expect(moreWords(fit)).toBe('7 above · scroll back');
  });
});
