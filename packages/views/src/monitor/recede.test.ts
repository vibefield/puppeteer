import { describe, expect, it } from 'vitest';
import {
  approachRecede,
  everyReceded,
  RECEDE_MS,
  RECEDED_EMPTY_OPACITY,
  RECEDED_OPACITY,
  recedeTarget,
} from './recede.js';
import type { MonitorAgent } from './types.js';

function row(id: string, receded?: boolean): MonitorAgent {
  return {
    id,
    createdAtMs: 0,
    status: 'idle',
    project: id,
    detail: '',
    color: 'currentColor',
    active: false,
    ...(receded === undefined ? {} : { receded }),
  };
}

describe('receding', () => {
  it('draws a shown row whole, a receded one at 22 %, and steps further back when nothing is shown', () => {
    expect(recedeTarget(false, false)).toBe(1);
    expect(recedeTarget(false, true)).toBe(1);
    expect(recedeTarget(true, false)).toBe(RECEDED_OPACITY);
    expect(recedeTarget(true, true)).toBe(RECEDED_EMPTY_OPACITY);
    expect(RECEDED_OPACITY).toBe(0.22);
    expect(RECEDED_EMPTY_OPACITY).toBe(0.07);
  });

  it('calls a stage all-receded only when it holds rows and every one is receded', () => {
    expect(everyReceded([])).toBe(false);
    expect(everyReceded([row('a', true), row('b', true)])).toBe(true);
    expect(everyReceded([row('a', true), row('b')])).toBe(false);
    expect(everyReceded([row('a', true), row('b', false)])).toBe(false);
  });

  it('recedes in 240 ms and comes back in 240 ms, one linear step per frame, never past its target', () => {
    let weight = 1;
    let elapsed = 0;
    while (weight !== RECEDED_OPACITY) {
      weight = approachRecede(weight, RECEDED_OPACITY, 16);
      elapsed += 16;
      expect(weight).toBeGreaterThanOrEqual(RECEDED_OPACITY);
    }
    expect(elapsed).toBeGreaterThanOrEqual(RECEDE_MS - 16);
    expect(elapsed).toBeLessThanOrEqual(RECEDE_MS + 16);
    expect(approachRecede(RECEDED_OPACITY, 1, RECEDE_MS)).toBe(1);
    expect(approachRecede(0.5, 0.5, 16)).toBe(0.5);
    // a clock that runs backwards moves nothing
    expect(approachRecede(0.5, 1, -40)).toBe(0.5);
  });
});
