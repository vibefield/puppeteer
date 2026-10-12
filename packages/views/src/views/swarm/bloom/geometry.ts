// The spawn bloom's geometry, pure: where buds stand, where their words sit,
// and which way a ring turns to fit. A 1:1 port of the prototype's audited
// geometry (draft/spawn-bloom/bloom.js, "geometry" and "the buds' words"):
// the same arithmetic in the same order, so the audit's numbers carry over.
// CSS px, y down; angles in degrees, 0 = right, 90 = down.

import { BLOOM, BLOOM_FONT, type BloomTextMeasure } from './constants.js';

export interface BloomPoint {
  readonly x: number;
  readonly y: number;
}

/** A width and height: the field's, or a label's. */
export interface BloomSize {
  readonly w: number;
  readonly h: number;
}

/** A rectangle in the chrome's terms (DOMRect-like): the field's chrome, a seated label as an obstacle. */
export interface BloomRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The least a box is, for the distance helpers. */
export interface BloomXYWH {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** How a label's text runs inside its box: away from its bud. */
export type BloomAlign = 'left' | 'center' | 'right';

/** A bud's label, placed. */
export interface BloomBox extends BloomXYWH {
  readonly align: BloomAlign;
}

export interface BloomDisc {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

export interface BloomSeg {
  readonly a: BloomPoint;
  readonly b: BloomPoint;
}

/** What a label must keep clear of: the field's edges (less the inset), the
 * chrome and seated labels (`rects`), buds and the hub (`discs`), spokes (`segs`). */
export interface BloomRoom {
  readonly field: BloomSize;
  readonly rects?: readonly BloomRect[] | undefined;
  readonly discs?: readonly BloomDisc[] | undefined;
  readonly segs?: readonly BloomSeg[] | undefined;
}

/** A bud's words: its name, and (a desktop's) state line under it. */
export interface BloomLabelText {
  readonly name: string;
  readonly sub?: string | undefined;
}

/** Where a label sits, what that place costs (0: clear), and whether it is the name alone. */
export interface BloomSeat {
  readonly box: BloomBox;
  readonly cost: number;
  readonly short: boolean;
}

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function polar(cx: number, cy: number, r: number, deg: number): BloomPoint {
  return { x: cx + r * Math.cos(rad(deg)), y: cy + r * Math.sin(rad(deg)) };
}

/** The direction of (dx, dy), in degrees (−180..180]. */
export function angleOf(dx: number, dy: number): number {
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** The unsigned difference of two directions, 0..180. */
export function angDiff(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

/** A label's size in its own type (`BLOOM_FONT.label`, and `.sub` for the
 * state line), letter spacing added per character as the prototype does. */
export function labelSize(label: BloomLabelText, measure: BloomTextMeasure): BloomSize {
  const w1 = measure(label.name, BLOOM_FONT.label) + label.name.length * 0.57;
  let w2 = 0;
  if (label.sub) w2 = measure(label.sub, BLOOM_FONT.sub) + label.sub.length * 0.75;
  return { w: Math.ceil(Math.max(w1, w2)) + 4, h: label.sub ? 23 : 12 };
}

/** Where a bud's words go: beside it when the spoke runs sideways, over or
 * under it when it runs up or down — never along the spoke's own line, where
 * the next bud would be. `force` puts them on one side. */
export function labelBox(
  x: number,
  y: number,
  deg: number,
  d: number,
  size: BloomSize,
  force?: 'left' | 'right' | null,
): BloomBox {
  const ux = Math.cos(rad(deg));
  const uy = Math.sin(rad(deg));
  const gap = BLOOM.labelGap;
  if (force === 'left') return { x: x - d / 2 - gap - size.w, y: y - size.h / 2, w: size.w, h: size.h, align: 'right' };
  if (force === 'right') return { x: x + d / 2 + gap, y: y - size.h / 2, w: size.w, h: size.h, align: 'left' };
  if (Math.abs(ux) < 0.42) {
    return {
      x: x - size.w / 2,
      y: uy < 0 ? y - d / 2 - gap - size.h : y + d / 2 + gap,
      w: size.w,
      h: size.h,
      align: 'center',
    };
  }
  if (ux > 0) return { x: x + d / 2 + gap, y: y - size.h / 2, w: size.w, h: size.h, align: 'left' };
  return { x: x - d / 2 - gap - size.w, y: y - size.h / 2, w: size.w, h: size.h, align: 'right' };
}

/** How near a box comes to a point (0 inside it). */
export function rectGap(box: BloomXYWH, x: number, y: number): number {
  const dx = Math.max(box.x - x, 0, x - (box.x + box.w));
  const dy = Math.max(box.y - y, 0, y - (box.y + box.h));
  return Math.hypot(dx, dy);
}

/** How near a point comes to the segment a–b. */
export function pointSeg(px: number, py: number, a: BloomPoint, b: BloomPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** How near a box comes to the segment a–b: 0 when the segment passes
 * through it at all (Liang–Barsky), else the nearest of the ends to the box
 * and the box's corners to the segment. */
export function segGap(box: BloomXYWH, a: BloomPoint, b: BloomPoint): number {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - box.x, box.x + box.w - a.x, a.y - box.y, box.y + box.h - a.y];
  let hit = true;
  for (let k = 0; k < 4 && hit; k += 1) {
    const pk = p[k] as number;
    const qk = q[k] as number;
    if (pk === 0) {
      if (qk < 0) hit = false;
    } else {
      const r = qk / pk;
      if (pk < 0) {
        if (r > t1) hit = false;
        else if (r > t0) t0 = r;
      } else if (r < t0) hit = false;
      else if (r < t1) t1 = r;
    }
  }
  if (hit) return 0;
  let near = Math.min(rectGap(box, a.x, a.y), rectGap(box, b.x, b.y));
  const corners: ReadonlyArray<readonly [number, number]> = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ];
  for (const c of corners) near = Math.min(near, pointSeg(c[0], c[1], a, b));
  return near;
}

/** A bud's words toward any direction: leaning the way it points (beside the
 * bud when it points sideways, centred over or under it when it points up or
 * down, a corner toward it between), then out until none of the words is
 * nearer the bud than the gap. Whole px. */
export function labelToward(x: number, y: number, deg: number, d: number, size: BloomSize): BloomBox {
  const ux = Math.cos(rad(deg));
  const uy = Math.sin(rad(deg));
  const need = d / 2 + BLOOM.labelGap;
  const box = {
    x: x + ux * need - (size.w * (1 - ux)) / 2,
    y: y + uy * need - (size.h * (1 - uy)) / 2,
    w: size.w,
    h: size.h,
  };
  for (let i = 0; i < 40 && rectGap(box, x, y) < need - 0.25; i += 1) {
    box.x += ux;
    box.y += uy;
  }
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    w: box.w,
    h: box.h,
    align: Math.abs(ux) < 0.42 ? 'center' : ux > 0 ? 'left' : 'right',
  };
}

/** What a place costs a bud's words: nothing when it is inside the field and
 * clear of the chrome, of every other bud at its hot size, of every other
 * bud's words, of the hub, and of every spoke (the tether runs down a spoke
 * when you point along it). */
export function labelCost(box: BloomXYWH, room: BloomRoom): number {
  const inset = BLOOM.inset;
  const f = room.field;
  let c = 0;
  const out =
    Math.max(0, inset - box.x) +
    Math.max(0, inset - box.y) +
    Math.max(0, box.x + box.w - (f.w - inset)) +
    Math.max(0, box.y + box.h - (f.h - inset));
  if (out > 0) c += out + 8;
  for (const r of room.rects ?? []) {
    const ix = Math.min(box.x + box.w, r.x + r.width + BLOOM.clearWord) - Math.max(box.x, r.x - BLOOM.clearWord);
    const iy = Math.min(box.y + box.h, r.y + r.height + BLOOM.clearWord) - Math.max(box.y, r.y - BLOOM.clearWord);
    if (ix > 0 && iy > 0) c += Math.min(ix, iy) + 8;
  }
  for (const o of room.discs ?? []) {
    const g = rectGap(box, o.x, o.y) - o.r;
    if (g < BLOOM.clearBud) c += BLOOM.clearBud - g + 8;
  }
  for (const sg of room.segs ?? []) {
    const g = segGap(box, sg.a, sg.b);
    if (g < BLOOM.clearSpoke) c += BLOOM.clearSpoke - g + 8;
  }
  return c;
}

/** Where a bud's words sit: their natural place if it is clear; otherwise the
 * nearest clear place around their own bud, turned 15° at a time either way;
 * otherwise the name alone (`sizes[1]`), the same way round; otherwise the
 * least crowded place, with what it costs, so the caller can turn the arc or
 * let the words give way. */
export function seatLabel(
  x: number,
  y: number,
  d: number,
  natural: BloomBox,
  sizes: readonly (BloomSize | null | undefined)[],
  room: BloomRoom,
  naturalShort?: boolean,
): BloomSeat {
  const c0 = labelCost(natural, room);
  if (c0 === 0) return { box: natural, cost: 0, short: !!naturalShort };
  let best: BloomSeat = { box: natural, cost: c0, short: !!naturalShort };
  const deg0 = angleOf(natural.x + natural.w / 2 - x, natural.y + natural.h / 2 - y);
  for (let si = 0; si < sizes.length; si += 1) {
    const size = sizes[si];
    if (!size) continue;
    for (let k = 0; k <= 23; k += 1) {
      const box = labelToward(x, y, deg0 + turnAt(k), d, size);
      const c = labelCost(box, room);
      if (c === 0) return { box, cost: 0, short: si > 0 };
      if (c < best.cost) best = { box, cost: c, short: si > 0 };
    }
  }
  return best;
}

/** How far a box runs past the field (less the inset) and onto the chrome (6 px round it). */
export function overflow(box: BloomXYWH, field: BloomSize, obstacles: readonly BloomRect[]): number {
  const inset = BLOOM.inset;
  let o = 0;
  o += Math.max(0, inset - box.x);
  o += Math.max(0, inset - box.y);
  o += Math.max(0, box.x + box.w - (field.w - inset));
  o += Math.max(0, box.y + box.h - (field.h - inset));
  for (const r of obstacles) {
    const ix = Math.min(box.x + box.w, r.x + r.width + 6) - Math.max(box.x, r.x - 6);
    const iy = Math.min(box.y + box.h, r.y + r.height + 6) - Math.max(box.y, r.y - 6);
    if (ix > 0 && iy > 0) o += Math.min(ix, iy) + 8;
  }
  return o;
}

/** A ring round (cx, cy): `r` out, buds `d` across, `step`° apart, facing `prefer`°. */
export interface BloomArcSpec {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly d: number;
  readonly step: number;
  readonly prefer: number;
  readonly field: BloomSize;
  /** The chrome (and, for ring two, the first ring's seated labels). */
  readonly obstacles?: readonly BloomRect[] | undefined;
  /** What was already there: the hub, a first ring, the open desktop. */
  readonly discs?: readonly BloomDisc[] | undefined;
  /** The spoke that led here. */
  readonly segs?: readonly BloomSeg[] | undefined;
}

/** A bud's place on an arc and the direction of its spoke. */
export interface BloomArcPoint {
  readonly x: number;
  readonly y: number;
  readonly a: number;
}

/** What a ring's buds cost where they stand: past the field's edge, on the
 * chrome, on whatever discs were already there, on the spoke that led here. */
export function budsCost(pts: readonly BloomArcPoint[], spec: BloomArcSpec, hotR: number): number {
  let cost = 0;
  for (const pt of pts) {
    cost += overflow(
      { x: pt.x - spec.d / 2, y: pt.y - spec.d / 2, w: spec.d, h: spec.d },
      spec.field,
      spec.obstacles ?? [],
    );
    for (const o of spec.discs ?? []) {
      const g = Math.hypot(pt.x - o.x, pt.y - o.y) - o.r - hotR;
      if (g < 6) cost += 14 - g;
    }
    for (const sg of spec.segs ?? []) {
      const g = pointSeg(pt.x, pt.y, sg.a, sg.b) - hotR;
      if (g < 6) cost += 14 - g;
    }
  }
  return cost;
}

/** n buds centred on `theta`, `step`° apart, in arc order. */
export function arcPoints(spec: BloomArcSpec, theta: number, step: number, n: number): BloomArcPoint[] {
  const pts: BloomArcPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = theta + (i - (n - 1) / 2) * step;
    const p = polar(spec.cx, spec.cy, spec.r, a);
    pts.push({ x: p.x, y: p.y, a });
  }
  return pts;
}

/** The spacing for n buds: the spec's, narrowed so the arc spans at most 220°. */
export function arcStep(spec: BloomArcSpec, n: number): number {
  return n > 1 ? Math.min(spec.step, 220 / (n - 1)) : spec.step;
}

/** The k-th turn tried: 0, +15, −15, +30, −30, … */
export function turnAt(k: number): number {
  return k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 15;
}

/** Whether n buds can bloom round (cx, cy) turned no more than `maxTurn` from
 * the way they face. The first ring asks it of every desktop it offers: a
 * desktop's profiles bloom onward (at most square to the spoke), never back
 * toward the hub, and never onto its siblings. */
export function arcFits(spec: BloomArcSpec, n: number, maxTurn: number): boolean {
  const step = arcStep(spec, n);
  const hotR = (spec.d * BLOOM.hot) / 2;
  for (let k = 0; k <= 24; k += 1) {
    if (Math.abs(turnAt(k)) > maxTurn) break;
    if (budsCost(arcPoints(spec, spec.prefer + turnAt(k), step, n), spec, hotR) === 0) return true;
  }
  return false;
}

/** One more bud's words a ring should leave room for: the open desktop's, round its own bud. */
export interface BloomArcExtra {
  readonly x: number;
  readonly y: number;
  readonly d: number;
  /** Where its words stand now (their home seat). */
  readonly natural: BloomBox;
  readonly short?: boolean | undefined;
  /** Its full size, and its name alone (null when it has no state line). */
  readonly sizes: readonly (BloomSize | null | undefined)[];
}

export interface BloomLayoutArcSpec extends BloomArcSpec {
  /** One per bud, in the menu's order. */
  readonly labels: readonly BloomLabelText[];
  readonly measure: BloomTextMeasure;
  /** The caller's own cost for a turn (the first ring's lookahead), given the points in reading order. */
  readonly also?: ((pts: readonly BloomArcPoint[]) => number) | undefined;
  readonly extra?: BloomArcExtra | undefined;
}

/** A bud as the arc placed it, its words seated. */
export interface BloomArcItem {
  readonly x: number;
  readonly y: number;
  readonly a: number;
  readonly label: BloomBox;
  readonly short: boolean;
}

/** The turn chosen, its buds in reading order, and what each rule cost there. */
export interface BloomArcLayout {
  readonly theta: number;
  readonly items: readonly BloomArcItem[];
  readonly step: number;
  readonly turn: number;
  /** The extra words stayed clear (true when there were none). */
  readonly kept: boolean;
  readonly bud: number;
  readonly word: number;
  readonly also: number;
  readonly cost: number;
}

/** n buds around (cx, cy): the preferred direction first, then turned in 15°
 * steps either way until everything fits — the buds inside the field, off the
 * chrome and clear of whatever was already there (`discs`: the hub, a first
 * ring; `segs`: the spoke that led here), and every bud's words seated clear
 * of all of it (a word moves round its own bud before the arc turns). `extra`
 * is one more bud's words the ring should leave room for — the open desktop's,
 * round its own bud — and the ring turns up to 45° past its first clear turn
 * to keep them; past that they give way instead. `also(pts)` is a caller's own
 * cost for a turn (the first ring's lookahead). The turn is chosen in STRICT
 * order — the buds fit, then the words, then `also`, then `extra` — each only
 * breaking the ties of the one before, so nothing lower down can push a bud
 * off the field. Items come back in reading order (left to right, or top to
 * bottom when the arc faces sideways): item i carries `labels[i]`. */
export function layoutArc(spec: BloomLayoutArcSpec): BloomArcLayout {
  const n = spec.labels.length;
  const step = arcStep(spec, n);
  const sizes = spec.labels.map((l) => labelSize(l, spec.measure));
  const shorts = spec.labels.map((l) => (l.sub ? labelSize({ name: l.name }, spec.measure) : null));
  const hotR = (spec.d * BLOOM.hot) / 2;
  const rects0 = spec.obstacles ?? [];
  const discs0 = spec.discs ?? [];
  const segs0 = spec.segs ?? [];
  const tried: BloomArcLayout[] = [];
  for (let k = 0; k <= 24; k += 1) {
    const turn = turnAt(k);
    const theta = spec.prefer + turn;
    const pts = arcPoints(spec, theta, step, n);
    // reading order: along the arc's tangent, turned to run left to right
    // (or top to bottom when the arc faces sideways)
    let tx = -Math.sin(rad(theta));
    let ty = Math.cos(rad(theta));
    if (tx < -0.01 || (Math.abs(tx) <= 0.01 && ty < 0)) {
      tx = -tx;
      ty = -ty;
    }
    pts.sort((u, v) => u.x * tx + u.y * ty - (v.x * tx + v.y * ty));
    const budCost = budsCost(pts, spec, hotR);
    const alsoCost = spec.also ? spec.also(pts) : 0;
    let wordCost = 0;
    // this ring's own buds and spokes join what was already there
    const ringDiscs: BloomDisc[] = pts.map((pt) => ({ x: pt.x, y: pt.y, r: hotR }));
    const segs: BloomSeg[] = segs0.concat(
      pts.map((pt) => ({ a: { x: spec.cx, y: spec.cy }, b: { x: pt.x, y: pt.y } })),
    );
    // Words start where they read best: on an arc that faces up or down the
    // two outer buds carry theirs beside them, and a word over a middle bud
    // is held to the chord between neighbours. Then each is seated.
    const vertical = Math.abs(Math.sin(rad(theta))) > 0.7;
    const chord = 2 * spec.r * Math.sin(rad(step / 2)) - 6;
    const seated: BloomRect[] = [];
    const items = pts.map((pt, j): BloomArcItem => {
      const centred = Math.abs(Math.cos(rad(pt.a))) < 0.42;
      const force = vertical && n >= 2 && centred ? (j === 0 ? 'left' : j === n - 1 ? 'right' : null) : null;
      const full = sizes[j] as BloomSize;
      let size = full;
      if (centred && !force && n >= 2) size = { w: Math.min(size.w, chord), h: size.h };
      const natural = labelBox(pt.x, pt.y, pt.a, spec.d, size, force);
      const seat = seatLabel(pt.x, pt.y, spec.d, natural, [full, shorts[j]], {
        field: spec.field,
        rects: rects0.concat(seated),
        discs: discs0.concat(ringDiscs.filter((_, m) => m !== j)),
        segs,
      });
      wordCost += seat.cost;
      seated.push({ x: seat.box.x, y: seat.box.y, width: seat.box.w, height: seat.box.h });
      return { x: pt.x, y: pt.y, a: pt.a, label: seat.box, short: seat.short };
    });
    let kept = true;
    const ex = spec.extra;
    if (ex) {
      const exSeat = seatLabel(
        ex.x,
        ex.y,
        ex.d,
        ex.natural,
        ex.sizes,
        {
          field: spec.field,
          rects: rects0.concat(seated),
          discs: discs0.filter((o) => o.x !== ex.x || o.y !== ex.y).concat(ringDiscs),
          segs,
        },
        ex.short,
      );
      kept = exSeat.cost === 0;
    }
    const here: BloomArcLayout = {
      theta,
      items,
      step,
      turn,
      kept,
      bud: budCost,
      word: wordCost,
      also: alsoCost,
      cost: budCost + wordCost + alsoCost,
    };
    // the first turn where everything fits, keeping the extra words, is the one
    const clearBefore = tried.some((t) => t.cost === 0);
    if (here.cost === 0 && kept && !clearBefore) return here;
    tried.push(here);
  }
  // otherwise relax from the bottom up: the extra words, then `also`, then
  // the words — never the buds
  const keepExtra = (list: readonly BloomArcLayout[]): BloomArcLayout => {
    const first = list[0] as BloomArcLayout;
    return list.find((t) => t.kept && angDiff(t.turn, first.turn) <= 45) ?? first;
  };
  const least = (list: readonly BloomArcLayout[], key: (t: BloomArcLayout) => number): BloomArcLayout =>
    list.reduce((a, b) => (key(b) < key(a) - 0.5 ? b : a));
  const clear = tried.filter((t) => t.cost === 0);
  if (clear.length) return keepExtra(clear);
  const fits = tried.filter((t) => t.bud === 0 && t.word === 0);
  if (fits.length) {
    const lo = least(fits, (t) => t.also).also;
    return keepExtra(fits.filter((t) => t.also <= lo + 0.5));
  }
  const budsFit = tried.filter((t) => t.bud === 0);
  if (budsFit.length) return least(budsFit, (t) => t.word + t.also);
  return least(tried, (t) => t.bud * 1000 + t.word + t.also);
}
