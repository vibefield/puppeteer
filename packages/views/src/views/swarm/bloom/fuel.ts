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
//
// A host may instead hand the picture it drew (`MonitorSpawnFuel.drawn`).
// Then this file only picks the drawing made for the bud's size, reads it
// tolerantly, and turns its arcs into SVG paths: no window, band or pace
// rule of the host's lives here.

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

type BloomDrawn = Extract<BloomFuel, { kind: 'drawn' }>;
type Fields = Readonly<Record<string, unknown>>;

// A host's drawing, read tolerantly by puppeteer's own limits (no host's rule): the first 4 valid drawings, 48 arcs and
// 16 notches each, and no stroke past 2 px beyond the bud's rim as the bud draws it, so the audited `labelGap` (8)
// keeps 6 to spare at any scale.
const MOST_DRAWINGS = 4;
const MOST_ARCS = 48;
const MOST_NOTCHES = 16;
const RIM_SLACK = 2;
/** A whole ring: a sweep of 359.9 or more, less a float's slack (`from + 359.9 - from` may be 359.8999…). */
const WHOLE_TURN = 359.9 - 1e-9;
/** A drawing this close to the bud's diameter is the bud's own. */
const SAME_SIZE = 0.01;

function fields(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null ? (value as Fields) : null;
}

function toneOf(value: unknown): MonitorSpawnFuelTone | null {
  return value === 'ink' || value === 'hot' ? value : null;
}

/** An absent opacity is 1, and one that is there is clamped to 0..1; undefined for one that is not a number. */
function opacityOf(value: unknown): number | undefined {
  if (value === undefined) return 1;
  return finite(value) ? print(Math.min(1, Math.max(0, value))) : undefined;
}

/** A dash and its gap, two numbers of 0 or more that add to more than 0; null for anything else (a solid stroke). */
function dashOf(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [dash, gap] = value as readonly unknown[];
  if (!finite(dash) || !finite(gap) || dash < 0 || gap < 0) return null;
  const printed = [print(dash), print(gap)] as const;
  return printed[0] + printed[1] > 0 ? printed : null;
}

/** One arc, or null to skip it: a number that is not finite, no radius or width, no sweep, an unknown tone, or a
 * stroke that reaches past `reach` from the middle. */
function arcOf(value: unknown, reach: number): BloomArc | null {
  const arc = fields(value);
  if (!arc) return null;
  const { r, width, from, to, percent: share } = arc;
  const tone = toneOf(arc.tone);
  const opacity = opacityOf(arc.opacity);
  if (!finite(r) || !finite(width) || !finite(from) || !finite(to) || !finite(share)) return null;
  if (tone === null || opacity === undefined || r <= 0 || width <= 0 || to <= from) return null;
  if (r + width / 2 > reach) return null;
  return {
    r: print(r),
    width: print(width),
    from,
    to,
    circle: to - from >= WHOLE_TURN,
    tone,
    percent: print(percent(share)),
    opacity,
    cap: arc.cap === 'round' ? 'round' : 'butt',
    dash: dashOf(arc.dash),
  };
}

/** One notch, or null to skip it: a number that is not finite, no width, an unknown tone, or an end past `reach`
 * from the middle `c`. */
function notchOf(value: unknown, c: number, reach: number): BloomNotch | null {
  const notch = fields(value);
  if (!notch) return null;
  const { x1, y1, x2, y2, width, percent: share } = notch;
  const tone = toneOf(notch.tone);
  const opacity = opacityOf(notch.opacity);
  if (!finite(x1) || !finite(y1) || !finite(x2) || !finite(y2) || !finite(width) || !finite(share)) return null;
  if (tone === null || opacity === undefined || width <= 0) return null;
  if (Math.hypot(x1 - c, y1 - c) > reach || Math.hypot(x2 - c, y2 - c) > reach) return null;
  return {
    x1: print(x1),
    y1: print(y1),
    x2: print(x2),
    y2: print(y2),
    width: print(width),
    tone,
    percent: print(percent(share)),
    opacity,
  };
}

/** The first `most` entries of a list that `read` keeps; nothing for what is not a list. */
function firstValid<T>(list: unknown, most: number, read: (value: unknown) => T | null): T[] {
  const kept: T[] = [];
  if (!Array.isArray(list)) return kept;
  for (const value of list as readonly unknown[]) {
    if (kept.length >= most) break;
    const each = read(value);
    if (each !== null) kept.push(each);
  }
  return kept;
}

/** One drawing, or null when it has no finite size above 0 or no stroke the bud can draw. Its strokes are judged as a
 * `d`-wide bud draws them (scaled by `d / size`): the slack is 2 of the bud's px, `2 * size / d` of the drawing's. */
function drawingOf(value: unknown, d: number): BloomDrawn | null {
  const drawing = fields(value);
  const size = drawing?.size;
  if (!drawing || !finite(size) || size <= 0) return null;
  const c = size / 2;
  const reach = c + (RIM_SLACK * size) / (finite(d) && d > 0 ? d : size);
  const arcs = firstValid(drawing.arcs, MOST_ARCS, (arc) => arcOf(arc, reach));
  const notches = firstValid(drawing.notches, MOST_NOTCHES, (notch) => notchOf(notch, c, reach));
  return arcs.length > 0 || notches.length > 0 ? { kind: 'drawn', size: print(size), arcs, notches } : null;
}

/** The drawing made for a `d`-wide bud: one within 0.01 of `d`, else the nearest, the larger on a tie. */
function pick(drawings: readonly BloomDrawn[], d: number): BloomDrawn | null {
  let best: BloomDrawn | null = null;
  for (const drawing of drawings) {
    const off = Math.abs(drawing.size - d);
    if (off <= SAME_SIZE) return drawing;
    const bestOff = best === null ? Number.POSITIVE_INFINITY : Math.abs(best.size - d);
    if (off < bestOff || (off === bestOff && best !== null && drawing.size > best.size)) best = drawing;
  }
  return best;
}

/** The fuel a bud `d` across wears, or null for none. A valid drawing (`drawn`) wins, picked for `d`; else a finite
 * `usedPercent` is a reading and wins over `unread`; and anything malformed draws today's bud. */
export function budFuel(profile: MonitorSpawnProfile, d: number): BloomFuel | null {
  const fuel: unknown = profile.fuel;
  if (typeof fuel !== 'object' || fuel === null) return null;
  const { usedPercent, elapsedPercent, hot, stale, unread, drawn } = fuel as Readonly<Record<string, unknown>>;
  const drawing = pick(firstValid(drawn, MOST_DRAWINGS, (each) => drawingOf(each, d)), d);
  if (drawing) return drawing;
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
 * past a half turn; every number rounded to 2 places. Plain SVG geometry, no rule. */
export function arcD(c: number, r: number, from: number, to: number): string {
  const at = (angle: number): string => {
    const radians = (angle * Math.PI) / 180;
    return `${print(c + r * Math.cos(radians))} ${print(c + r * Math.sin(radians))}`;
  };
  const turn = `A${print(r)} ${print(r)} 0 0 1 `;
  const start = `M${at(from)}${turn}`;
  return to - from > 180 ? `${start}${at(from + 180)}${turn}${at(to)}` : `${start}${at(to)}`;
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
