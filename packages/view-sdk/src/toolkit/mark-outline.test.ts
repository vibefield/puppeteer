import { describe, expect, it } from 'vitest';
import { MARK_STROKE, MARK_VIEW_BOX, ringOutline, strokeOutline, strokesOutline } from './mark-outline.js';

describe('a mark as filled outlines (MV-D6: the bar fills, never strokes)', () => {
  it('is drawn on the bar’s grid at its monoline weight', () => {
    expect(MARK_VIEW_BOX).toBe('0 0 24 24');
    expect(MARK_STROKE).toBe(1.6);
  });

  it('outlines a straight stroke with round caps, half its width either side of the line', () => {
    // The list's top rule, `M5 7h14` stroked at 1.6: a stadium from (5, 6.2) to (19, 7.8).
    expect(strokeOutline([5, 7], [19, 7])).toBe('M5 7.8L19 7.8A0.8 0.8 0 0 0 19 6.2L5 6.2A0.8 0.8 0 0 0 5 7.8Z');
    expect(strokeOutline([7, 4], [7, 9])).toBe('M6.2 4L6.2 9A0.8 0.8 0 0 0 7.8 9L7.8 4A0.8 0.8 0 0 0 6.2 4Z');
    // Either direction draws the same shape; another width scales the caps.
    expect(strokeOutline([19, 7], [5, 7])).toBe('M19 6.2L5 6.2A0.8 0.8 0 0 0 5 7.8L19 7.8A0.8 0.8 0 0 0 19 6.2Z');
    expect(strokeOutline([0, 0], [10, 0], 2)).toBe('M0 1L10 1A1 1 0 0 0 10 -1L0 -1A1 1 0 0 0 0 1Z');
  });

  it('outlines a slanted stroke and a dot', () => {
    expect(strokeOutline([14.6, 14.6], [20, 20])).toBe(
      'M14.0343 15.1657L19.4343 20.5657A0.8 0.8 0 0 0 20.5657 19.4343L15.1657 14.0343A0.8 0.8 0 0 0 14.0343 15.1657Z',
    );
    expect(strokeOutline([3, 3], [3, 3])).toBe('M2.2 3A0.8 0.8 0 1 0 3.8 3A0.8 0.8 0 1 0 2.2 3Z');
  });

  it('joins several strokes as subpaths of one path', () => {
    expect(
      strokesOutline([
        [
          [5, 7],
          [19, 7],
        ],
        [
          [5, 12],
          [19, 12],
        ],
      ]),
    ).toBe(strokeOutline([5, 7], [19, 7]) + strokeOutline([5, 12], [19, 12]));
  });

  it('outlines a stroked circle as a ring: the inner edge wound against the outer, so it fills as a hole', () => {
    expect(ringOutline(7.5, 8, 3)).toBe(
      'M3.7 8A3.8 3.8 0 1 0 11.3 8A3.8 3.8 0 1 0 3.7 8Z' + 'M5.3 8A2.2 2.2 0 1 1 9.7 8A2.2 2.2 0 1 1 5.3 8Z',
    );
    // A circle narrower than its stroke has no hole left.
    expect(ringOutline(0, 0, 0.5)).toBe('M-1.3 0A1.3 1.3 0 1 0 1.3 0A1.3 1.3 0 1 0 -1.3 0Z');
  });
});
