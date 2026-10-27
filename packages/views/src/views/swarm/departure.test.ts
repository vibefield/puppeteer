import { describe, expect, it } from 'vitest';
import {
  DEPARTURE_MS,
  DEPARTURE_REDUCED_MS,
  departureLength,
  departureMotion,
  departuresAfter,
  easeOut,
  leaving,
  retractEase,
  type Departure,
} from './departure.js';

// A body leaving the field (DESIGN §6 "The departure", under M4: depart is not vanish; Q12): the curves as CSS draws
// them, the three forms, and the ledger the swarm keeps of who is leaving. What the swarm draws from them is
// swarm-view.test.tsx's.

describe('the curves', () => {
  it('solve the retract and ease-out as CSS does', () => {
    expect(retractEase(0)).toBe(0);
    expect(retractEase(1)).toBe(1);
    // cubic-bezier(0.4, 0, 1, 1) at its parameter's middle stands at x 0.65, y 0.5
    expect(retractEase(0.65)).toBeCloseTo(0.5, 4);
    // cubic-bezier(0, 0, 0.58, 1) at its parameter's middle stands at x 0.3425, y 0.5
    expect(easeOut(0.3425)).toBeCloseTo(0.5, 4);
  });
});

describe('a leaving body', () => {
  it('with motion shrinks over the pop’s own length on the retract, at full opacity, then is gone', () => {
    expect(DEPARTURE_MS).toBe(280);
    expect(leaving(0, 'motion')).toEqual({ scale: 1, opacity: 1 });
    // it accelerates away: by half the time less than half the shrink is done
    const half = leaving(DEPARTURE_MS / 2, 'motion');
    expect(half?.scale).toBeGreaterThan(0.5);
    expect(half?.opacity).toBe(1);
    let previous = 1;
    for (let elapsed = 16; elapsed < DEPARTURE_MS; elapsed += 16) {
      const step = leaving(elapsed, 'motion');
      expect(step?.opacity).toBe(1);
      expect(step?.scale).toBeLessThan(previous);
      expect(step?.scale).toBeGreaterThan(0);
      previous = step?.scale ?? 0;
    }
    expect(leaving(DEPARTURE_MS, 'motion')).toBeUndefined();
  });

  it('under reduced motion fades where it stands, at its size, in half the time (M6)', () => {
    expect(DEPARTURE_REDUCED_MS).toBe(DEPARTURE_MS / 2);
    expect(leaving(0, 'reduced')).toEqual({ scale: 1, opacity: 1 });
    const half = leaving(DEPARTURE_REDUCED_MS / 2, 'reduced');
    expect(half?.scale).toBe(1);
    // ease-out: more than half the fade is done by half the time
    expect(half?.opacity).toBeLessThan(0.5);
    expect(half?.opacity).toBeGreaterThan(0);
    expect(leaving(DEPARTURE_REDUCED_MS, 'reduced')).toBeUndefined();
  });

  it('on a still stage is gone at once: nothing moves on it', () => {
    expect(departureLength('still')).toBe(0);
    expect(leaving(0, 'still')).toBeUndefined();
  });

  it('reads the field’s motion from the host’s switch first, then the person’s preference', () => {
    expect(departureMotion({ animations: true, reducedMotion: false })).toBe('motion');
    expect(departureMotion({ animations: true, reducedMotion: true })).toBe('reduced');
    expect(departureMotion({ animations: false, reducedMotion: false })).toBe('still');
    expect(departureMotion({ animations: false, reducedMotion: true })).toBe('still');
  });
});

describe('who is leaving once the rows change', () => {
  const models = new Map([
    ['a', 'model a'],
    ['b', 'model b'],
    ['c', 'model c'],
  ]);
  const everyDrawn = (): boolean => true;

  it('starts a departure for every drawn body whose row left, with the model it was drawn from', () => {
    const { departing, returned } = departuresAfter(new Map(), models, new Set(['a']), 1000, everyDrawn);
    expect([...departing]).toEqual([
      ['b', { at: 1000, model: 'model b' }],
      ['c', { at: 1000, model: 'model c' }],
    ]);
    expect(returned.size).toBe(0);
  });

  it('keeps a leaving body’s start while it leaves, and hands back one whose row returned', () => {
    const before = new Map<string, Departure<string>>([
      ['b', { at: 900, model: 'model b, as drawn' }],
      ['c', { at: 950, model: 'model c, as drawn' }],
    ]);
    // the models the field draws from no longer hold b or c: their rows had left
    const now = new Map([['a', 'model a']]);
    const { departing, returned } = departuresAfter(before, now, new Set(['a', 'c']), 1000, everyDrawn);
    expect([...departing]).toEqual([['b', { at: 900, model: 'model b, as drawn' }]]);
    expect([...returned]).toEqual([['c', { at: 950, model: 'model c, as drawn' }]]);
  });

  it('lets a body that was never drawn just go', () => {
    const { departing } = departuresAfter(new Map(), models, new Set(['a']), 1000, (id) => id !== 'c');
    expect([...departing.keys()]).toEqual(['b']);
  });

  it('starts nothing when no row left', () => {
    const { departing, returned } = departuresAfter(new Map(), models, new Set(['a', 'b', 'c']), 1000, everyDrawn);
    expect(departing.size).toBe(0);
    expect(returned.size).toBe(0);
  });
});
