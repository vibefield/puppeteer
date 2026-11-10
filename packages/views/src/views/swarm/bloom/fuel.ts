// A profile bud's fuel (UM-D7): one arc just inside its rim for the profile's
// tightest window, as a host reads it. The host decides everything the arc
// says (`MonitorSpawnFuel`); this file only reads it tolerantly and draws it.
//
// The numbers are the bands' level-one arithmetic for a one-plan whole ring
// (a band set off the bud's size, its outer edge 0.8 inside the disc, the
// fill and the notch laid along the arc that is left once the round caps have
// their share), so an on-pace fill ends on its tick as it does in the usage
// column on the same screen. The arc sits inside the disc so the audited
// `BLOOM` table (a 1.25 rim, `labelGap` 8) keeps every number it has.

import type { MonitorSpawnFuelTone, MonitorSpawnProfile } from '@vibefield/puppeteer-view-sdk';

/** A stroke a host drew (`MonitorSpawnFuelArc`) as the bud draws it: its lengths and shares rounded to the 2 places
 * they are printed at, `from` and `to` as handed (the path rounds its points). */
export interface BloomArc {
  readonly r: number;
  readonly width: number;
  readonly from: number;
  readonly to: number;
  /** A sweep of 359.9 or more: drawn as a whole circle. */
  readonly circle: boolean;
  readonly tone: MonitorSpawnFuelTone;
  readonly percent: number;
  readonly opacity: number;
  readonly cap: 'round' | 'butt';
  /** Null: a solid stroke. */
  readonly dash: readonly [number, number] | null;
}

/** A notch a host drew (`MonitorSpawnFuelNotch`) as the bud draws it, rounded as an arc is. */
export interface BloomNotch {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly tone: MonitorSpawnFuelTone;
  readonly percent: number;
  readonly opacity: number;
}

/** A bud's reading, the dashed thread that stands where there is none to draw, or the picture its host drew. */
export type BloomFuel =
  | {
      readonly kind: 'reading';
      readonly used: number;
      readonly elapsed: number | null;
      readonly hot: boolean;
      readonly stale: boolean;
    }
  | { readonly kind: 'unread' }
  | {
      readonly kind: 'drawn';
      /** The drawing's box, `size` square. The bud draws it at its own width: a drawing for another size scales. */
      readonly size: number;
      readonly arcs: readonly BloomArc[];
      readonly notches: readonly BloomNotch[];
    };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function percent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** The fuel a bud wears, or null for none: a finite `usedPercent` is a reading and wins over `unread`, and anything
 * malformed draws today's bud. Red: `d` and `drawn` are not read yet. */
export function budFuel(profile: MonitorSpawnProfile, d: number): BloomFuel | null {
  const fuel: unknown = profile.fuel;
  if (typeof fuel !== 'object' || fuel === null) return null;
  const { usedPercent, elapsedPercent, hot, stale, unread } = fuel as Readonly<Record<string, unknown>>;
  if (finite(usedPercent)) {
    return {
      kind: 'reading',
      used: percent(usedPercent),
      elapsed: finite(elapsedPercent) ? percent(elapsedPercent) : null,
      hot: hot === true,
      stale: stale === true,
    };
  }
  return unread === true ? { kind: 'unread' } : null;
}

/** The host's one clause for the words' line, in its capitals; '' for anything but a non-blank string. */
export function fuelWord(profile: MonitorSpawnProfile | null | undefined): string {
  const word: unknown = profile?.fuel?.word;
  return typeof word === 'string' ? word.trim().toUpperCase() : '';
}

/** The clause a bud's accessible name carries; '' with no word. */
export function fuelAria(profile: MonitorSpawnProfile): string {
  const word = fuelWord(profile);
  return word ? ', ' + word.toLowerCase() : '';
}

/** The ring as drawn on a `d`-wide bud, every number rounded to the 2 places it is printed at. */
export interface BloomRing {
  readonly r: number;
  readonly band: number;
  /** The fill, on `pathLength` 100. Null: nothing to fill (a share too small to see, or no reading). */
  readonly fill: { readonly dash: string; readonly rotate: number } | null;
  /** The notch at the time gone. Null: no time to mark. */
  readonly tick: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } | null;
  /** The dashed thread, for a bud with no reading. */
  readonly thread: { readonly width: number; readonly dash: string };
}

const print = (value: number): number => Math.round(value * 100) / 100;

/** A host's arc as an SVG path about `c`, clockwise from `from` to `to` (degrees, 0 at three o'clock), in two halves
 * past a half turn; every number rounded to 2 places. Red: no path yet. */
export function arcD(c: number, r: number, from: number, to: number): string {
  return '';
}

const RIM_INSET = 0.8;
const NOTCH_OVERHANG = 1.5;
/** A fill at or below this share has nothing to show. */
const FILL_FLOOR = 0.4;

export function budRing(d: number, fuel: BloomFuel): BloomRing {
  const band = Math.min(3.4, Math.max(2.6, d * 0.066));
  const r = d / 2 - RIM_INSET - band / 2;
  const cap = ((band / 2 / r) * 180) / Math.PI;
  const len = Math.max(0.2, 360 - 2 * cap);
  const c = d / 2;
  const threadWidth = Math.max(1.15, band * 0.24);
  let fill: BloomRing['fill'] = null;
  let tick: BloomRing['tick'] = null;
  if (fuel.kind === 'reading') {
    if (fuel.used > FILL_FLOOR) {
      const sweep = Math.max(0.3, (len * fuel.used) / 100);
      fill = { dash: `${print(sweep / 3.6)} 200`, rotate: print(-90 + cap) };
    }
    if (fuel.elapsed !== null) {
      const angle = ((-90 + 2 * cap + (len * fuel.elapsed) / 100) * Math.PI) / 180;
      const from = r - band / 2 - NOTCH_OVERHANG;
      const to = r + band / 2 + NOTCH_OVERHANG;
      tick = {
        x1: print(c + from * Math.cos(angle)),
        y1: print(c + from * Math.sin(angle)),
        x2: print(c + to * Math.cos(angle)),
        y2: print(c + to * Math.sin(angle)),
      };
    }
  }
  return {
    r: print(r),
    band: print(band),
    fill,
    tick,
    thread: { width: print(threadWidth), dash: `0.01 ${print(Math.max(2.5, threadWidth * 2.6))}` },
  };
}
