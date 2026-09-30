import { describe, expect, it } from 'vitest';
import { BLOOM } from './constants.js';
import { polar, type BloomPoint } from './geometry.js';
import { menuOf, type BloomDeviceItem, type BloomOpenMenu, type BloomProfileItem } from './menu.js';
import { BLOOM_SCENARIOS } from './scenarios.js';
import { nearest, resolveTarget, type BloomTargetState } from './targeting.js';

const menu = menuOf(BLOOM_SCENARIOS.two) as BloomOpenMenu;
const [studio, mini] = menu.items as [BloomDeviceItem, BloomDeviceItem];
const P: BloomPoint = { x: 500, y: 300 };
// ring one faces up: studio at −111°, mini at −69°
const closed: BloomTargetState = {
  P,
  l1: [
    { a: -111, item: studio },
    { a: -69, item: mini },
  ],
  l1step: BLOOM.step1,
  l2: [],
  l2step: BLOOM.step2,
  open: null,
};
const at = (deg: number, r: number, from: BloomPoint = P) => polar(from.x, from.y, r, deg);

// mini open, its two profiles facing on along its spoke
const miniPos = at(-69, BLOOM.r1);
const [miniNative, personal] = (mini.device.profiles ?? []).map((profile): BloomProfileItem => ({
  kind: 'profile',
  device: mini.device,
  profile,
})) as [BloomProfileItem, BloomProfileItem];
const open = (readyAt: number): BloomTargetState => ({
  ...closed,
  l2: [
    { a: -89, item: miniNative },
    { a: -49, item: personal },
  ],
  open: { item: mini, pos: miniPos, readyAt },
});

describe('resolveTarget, ring one', () => {
  it('the dead zone is the hub', () => {
    expect(resolveTarget(closed, at(0, BLOOM.deadR), 0).t).toEqual({ kind: 'hub' });
  });

  it('past it, the bud nearest by direction, within its sector', () => {
    // half a sector: min(sectorMax 26, 42 / 2 + 4) = 25°
    expect(resolveTarget(closed, at(-111 + 20, 40), 0).t).toMatchObject({ kind: 'device', item: studio });
    expect(resolveTarget(closed, at(-69 + 24, 40), 0).t).toMatchObject({ kind: 'device', item: mini });
    expect(resolveTarget(closed, at(-69 + 26, 40), 0).t).toEqual({ kind: 'none' });
    expect(resolveTarget(closed, at(90, 60), 0).t).toEqual({ kind: 'none' });
  });

  it('past the ring by more than the slack is open ground', () => {
    expect(resolveTarget(closed, at(-111, BLOOM.r1 + BLOOM.slack - 0.5), 0).t).toMatchObject({ kind: 'device' });
    expect(resolveTarget(closed, at(-111, BLOOM.r1 + BLOOM.slack + 0.5), 0).t).toEqual({ kind: 'none' });
  });

  it('carries the distance, so the machine knows when the pointer reached the ring', () => {
    const t = resolveTarget(closed, at(-69, BLOOM.r1 - BLOOM.reach), 0).t;
    expect(t.kind === 'device' && t.d).toBeCloseTo(BLOOM.r1 - BLOOM.reach);
  });
});

describe('resolveTarget, a desktop open', () => {
  it('ignores the pointer until the ring settles', () => {
    const p = at(-49, BLOOM.r2, miniPos);
    expect(resolveTarget(open(1090), p, 1000).t).toMatchObject({ kind: 'device', item: mini });
    expect(resolveTarget(open(1090), p, 1090).t).toMatchObject({ kind: 'profile', item: personal });
  });

  it('keeps the desktop inside its own dead zone', () => {
    expect(resolveTarget(open(0), at(0, BLOOM.deadR, miniPos), 1000).t).toMatchObject({ kind: 'device', item: mini });
  });

  it('collapses when the pointer backs out toward the hub', () => {
    const back = resolveTarget(open(0), at(-69, BLOOM.r1 - BLOOM.backOut - 0.5), 1000);
    expect(back.collapse).toBe(true);
    expect(back.t).toMatchObject({ kind: 'device', item: mini });
    expect(resolveTarget(open(0), at(-69, BLOOM.r1 - BLOOM.backOut + 0.5), 1000).collapse).toBeUndefined();
  });

  it('switches to a sibling reached at ring radius', () => {
    const r = resolveTarget(open(0), at(-111, BLOOM.r1), 1000);
    expect(r.collapse).toBe(true);
    expect(r.t).toMatchObject({ kind: 'device', item: studio });
  });

  it('past its profiles’ ring by more than the slack is open ground', () => {
    const r = resolveTarget(open(0), at(-49, BLOOM.r2 + BLOOM.slack + 1, miniPos), 1000);
    expect(r.t).toEqual({ kind: 'none' });
  });
});

describe('nearest', () => {
  it('is the bud whose spoke is nearest the direction, across the ±180° seam', () => {
    const buds = [{ a: 170 }, { a: -90 }];
    expect(nearest(buds, -175)?.bud).toBe(buds[0]);
    expect(nearest(buds, -175)?.delta).toBe(15);
    expect(nearest([], 0)).toBeNull();
  });
});
