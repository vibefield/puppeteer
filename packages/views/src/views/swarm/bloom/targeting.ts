// The spawn bloom's selection model, pure: where the pointer is, read against
// what is open (the prototype's `resolveTarget`, `level1`, `nearest`). Time is
// a parameter: the settle window compares `now` with the ring's `readyAt`.

import { BLOOM } from './constants.js';
import { angDiff, angleOf, type BloomPoint } from './geometry.js';
import type { BloomDeviceItem, BloomMenuItem, BloomProfileItem } from './menu.js';

/** What letting go would do right now. `d` (a first-ring target's distance
 * from the hub) is how the machine knows the pointer has reached the ring. */
export type BloomTarget =
  | { readonly kind: 'hub' }
  | { readonly kind: 'none' }
  | { readonly kind: 'device'; readonly item: BloomDeviceItem; readonly d?: number | undefined }
  | { readonly kind: 'profile'; readonly item: BloomProfileItem; readonly d?: number | undefined };

/** The least a bud is to targeting: its spoke's direction and what it offers. */
export interface BloomTargetBud {
  readonly a: number;
  readonly item: BloomMenuItem;
}

/** The least a bloom is to targeting. */
export interface BloomTargetState {
  readonly P: BloomPoint;
  readonly l1: readonly BloomTargetBud[];
  readonly l1step: number;
  readonly l2: readonly BloomTargetBud[];
  readonly l2step: number;
  /** The open desktop: its item, where its bud stands, and when its ring starts listening. */
  readonly open: { readonly item: BloomDeviceItem; readonly pos: BloomPoint; readonly readyAt: number } | null;
}

/** A target for an item on a ring (its own kind), at `d` from the hub when it is on the first. */
export function targetOf(item: BloomMenuItem, d?: number): BloomTarget {
  return item.kind === 'device' ? { kind: 'device', item, d } : { kind: 'profile', item, d };
}

/** The item a target points at, if any. */
export function targetItem(t: BloomTarget | null | undefined): BloomMenuItem | undefined {
  return t && (t.kind === 'device' || t.kind === 'profile') ? t.item : undefined;
}

/** The bud whose spoke is nearest the pointer's direction. */
export function nearest<B extends { readonly a: number }>(
  buds: readonly B[] | null | undefined,
  a: number,
): { bud: B; delta: number } | null {
  let best: { bud: B; delta: number } | null = null;
  for (const bud of buds ?? []) {
    const delta = angDiff(a, bud.a);
    if (!best || delta < best.delta) best = { bud, delta };
  }
  return best;
}

function level1(s: BloomTargetState, d: number, dx: number, dy: number): BloomTarget {
  if (d <= BLOOM.deadR) return { kind: 'hub' };
  const best = nearest(s.l1, angleOf(dx, dy));
  const half = Math.min(BLOOM.sectorMax, s.l1step / 2 + 4);
  if (best && best.delta <= half && d <= BLOOM.r1 + BLOOM.slack) return targetOf(best.bud.item, d);
  return { kind: 'none' };
}

/** Where the pointer is, read against what is open. Past the dead zone the
 * nearest bud BY DIRECTION is the target, while the pointer stays within its
 * sector (half the spacing + 4°, at most `sectorMax`) and short of open ground
 * (`r + slack`); that is a marking menu's forgiveness under Pinterest's
 * picture. With a desktop open: back inside `r1 − backOut` collapses it; its
 * own dead zone and its settle window keep the desktop targeted; a sibling
 * desktop at ring radius switches (collapse, then that desktop). `collapse`
 * asks the caller to close the second ring and read again. */
export function resolveTarget(
  s: BloomTargetState,
  p: BloomPoint,
  now: number,
): { readonly collapse?: true; readonly t: BloomTarget } {
  const dx = p.x - s.P.x;
  const dy = p.y - s.P.y;
  const d = Math.hypot(dx, dy);
  if (s.open) {
    if (d < BLOOM.r1 - BLOOM.backOut) return { collapse: true, t: level1(s, d, dx, dy) };
    const c = s.open.pos;
    const dx2 = p.x - c.x;
    const dy2 = p.y - c.y;
    const d2 = Math.hypot(dx2, dy2);
    if (d2 <= BLOOM.deadR) return { t: { kind: 'device', item: s.open.item } };
    // a ring that has just opened ignores the pointer's momentum for a moment
    if (now < s.open.readyAt) return { t: { kind: 'device', item: s.open.item } };
    const a2 = angleOf(dx2, dy2);
    const best = nearest(s.l2, a2);
    const half2 = Math.min(BLOOM.sectorMax, s.l2step / 2 + 4);
    if (best && best.delta <= half2 && d2 <= BLOOM.r2 + BLOOM.slack) return { t: targetOf(best.bud.item) };
    // toward a sibling device instead?
    const other = level1(s, d, dx, dy);
    if (
      other.kind === 'device' &&
      other.item !== s.open.item &&
      d >= BLOOM.r1 - BLOOM.reach - 10 &&
      d <= BLOOM.r1 + 30
    ) {
      return { collapse: true, t: other };
    }
    return { t: { kind: 'none' } };
  }
  return { t: level1(s, d, dx, dy) };
}
