import { describe, expect, it } from 'vitest';
import { climb, SWARM_CLIMB, SWARM_WEIGHT } from './weight.js';

describe('the importance ladder', () => {
  it('rises from the faintest mark to the title, with no rung out of order', () => {
    const rungs = [
      SWARM_WEIGHT.watermark,
      SWARM_WEIGHT.hairline,
      SWARM_WEIGHT.edge,
      SWARM_WEIGHT.absent,
      SWARM_WEIGHT.rim,
      SWARM_WEIGHT.supporting,
      SWARM_WEIGHT.secondary,
      SWARM_WEIGHT.title,
    ];
    expect([...rungs].sort((a, b) => a - b)).toEqual(rungs);
    // The title is the theme's own extreme; nothing else reaches it.
    expect(SWARM_WEIGHT.title).toBe(1);
  });

  it('climbs from just above the track to the title, and clamps at both ends', () => {
    expect(climb(0)).toBe(SWARM_CLIMB.from);
    expect(climb(1)).toBe(SWARM_CLIMB.to);
    expect(climb(-1)).toBe(SWARM_CLIMB.from);
    expect(climb(2)).toBe(SWARM_CLIMB.to);
    // A lone flame still reads as more than an unlit slot.
    expect(climb(0)).toBeGreaterThan(SWARM_WEIGHT.hairline);
    // The four flames are evenly spaced, the last at the title's weight.
    expect([0, 1, 2, 3].map((slot) => climb(slot / 3))).toEqual([0.34, 0.56, 0.78, 1]);
  });
});
