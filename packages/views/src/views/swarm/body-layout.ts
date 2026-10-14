import { COPY_LADDER, type SwarmBubbleModel } from './bubble-model.js';
import {
  chordWidth,
  ladderCopy,
  layoutCopy,
  type CopyLayout,
  type TextMeasure,
  type TextStyle,
} from './text-layout.js';

// Where everything a body draws stands, and which of it the body keeps. Pure,
// so what each radius draws is testable with a fake measurer; the renderer
// draws the answer and decides nothing about it.
//
// The copy steps down first (`ladderCopy`, in `COPY_LADDER`'s order: full →
// name + tool → name only). The other drawn parts follow the same rule (SWF):
// the watermark takes its small size once the body is small or its copy has
// stepped down, and the context figure, the total and the burn row are drawn
// only where they keep clear of the copy that is kept, and of each other,
// inside the circle. The context RING is the rim's, and is always drawn.
//
// What a body keeps is decided at its eased radius, the size it is settling
// to; where it stands is placed at the radius drawn this frame (times the
// arrival's scale). So an arrival's bounce scales a body's words without
// making a line blink in and out at its dip.

/** The context figure and the total: one size, the same margin in from the rim. */
export const FIGURE_STYLE: TextStyle = { size: 10.5, weight: 800, letterSpacing: 0.02 };
export const FIGURE_MARGIN = 7;
/** The burn row keeps this much clear of the model line above and of the total below. */
export const BAND_MARGIN_TOP = 4;
export const BAND_MARGIN_BOTTOM = 8;
/** The burn ladder's own geometry: a flame's size and the gap between flames. */
export const FLAME_SIZE = 13;
export const FLAME_GAP = 3;
/** Where the flame's ink starts in its box, from the top: the path's own tip stands 1.8 down a 24 box. */
const FLAME_INK_TOP = 1.8 / 24;
/** The provider's mark behind the copy: its size, and its small size on a small or stepped-down body. */
export const WATERMARK_SIZE = 58;
export const WATERMARK_SMALL = 46;
/** A body this small or smaller wears the small watermark. */
const WATERMARK_SMALL_AT = 40;
/** How close a part may come to the copy, or to the part beside it, before they collide. */
const PART_CLEARANCE = 2;

export interface BodyLayout {
  /** The kept copy, fitted at the drawn radius. */
  copy: CopyLayout;
  /** The ladder took at least one line away. */
  stepped: boolean;
  /** The watermark's size, CSS px, before a working body's breath. */
  watermark: number;
  /** Centre of each part drawn, relative to the body's centre (down positive); absent where it is dropped. */
  top?: number;
  bottom?: number;
  burn?: number;
}

export interface BodyLayoutOptions {
  /** The eased radius: what the body keeps is decided here. */
  radius: number;
  /** The arrival's scale (1 once landed): the copy is fitted, and the parts placed, at radius × scale. */
  scale?: number;
  measure: TextMeasure;
}

/** How many flames the burn row draws: the lit ones, or one hollow flame where nothing prices the work. */
export function burnFlamesDrawn(model: SwarmBubbleModel): number {
  const burn = model.burn;
  if (!burn) return 0;
  return burn.priced ? burn.lit : 1;
}

/** The copy's foot, which the burn row keeps under: the model line's, or the stack's once the model line is gone. */
function copyFoot(copy: CopyLayout): number {
  const modelLine = copy.lines.find((line) => line.key === 'model');
  return modelLine ? modelLine.y + modelLine.height / 2 : copy.bottom;
}

/** The burn row's centre: midway between a margin under the model line and a margin above the total figure, so
 * the flames stand where the chart used to, whatever the radius. */
function burnRowAt(radius: number, copy: CopyLayout): number {
  const top = copyFoot(copy) + BAND_MARGIN_TOP;
  const floor = Math.max(top + 4, radius - FIGURE_MARGIN - FIGURE_STYLE.size - BAND_MARGIN_BOTTOM);
  return (top + floor) / 2;
}

const figureInset = FIGURE_MARGIN + FIGURE_STYLE.size / 2;

export function bodyLayout(model: SwarmBubbleModel, options: BodyLayoutOptions): BodyLayout {
  const { radius, measure } = options;
  const scale = options.scale ?? 1;
  const drawn = radius * scale;
  const maxWidthRatio = model.copyMaxWidthRatio;
  const decided = ladderCopy(model.copy, { radius, measure, maxWidthRatio, order: COPY_LADDER });
  const stepped = decided.lines.length < model.copy.length;
  const kept = stepped
    ? model.copy.filter((line) => decided.lines.some((placed) => placed.key === line.key))
    : model.copy;
  const copy = scale === 1 ? decided : layoutCopy(kept, { radius: drawn, measure, maxWidthRatio });
  const layout: BodyLayout = {
    copy,
    stepped,
    watermark: drawn <= WATERMARK_SMALL_AT || stepped ? WATERMARK_SMALL : WATERMARK_SIZE,
  };

  // The figures, decided at the eased radius against the copy kept there: each on its chord, clear of the copy,
  // and inside the circle along its own line.
  const half = FIGURE_STYLE.size / 2;
  const inside = (text: string, centre: number): boolean =>
    measure(text, FIGURE_STYLE) <= chordWidth(radius, centre, centre);
  const top = model.figures?.top;
  const topAt = -radius + figureInset;
  const keepTop = top !== undefined && topAt + half + PART_CLEARANCE <= decided.top && inside(top.text, topAt);
  const bottom = model.figures?.bottom;
  const bottomAt = radius - figureInset;
  const keepBottom =
    bottom !== undefined && bottomAt - half - PART_CLEARANCE >= decided.bottom && inside(bottom.text, bottomAt);
  if (keepTop) layout.top = -drawn + figureInset;
  if (keepBottom) layout.bottom = drawn - figureInset;

  // The burn row between them: its flames' tips clear of the copy's foot above, clear of a kept total below, and
  // every flame inside the circle at the row's lower edge.
  const flames = burnFlamesDrawn(model);
  if (flames > 0) {
    const row = burnRowAt(radius, decided);
    const span = flames * FLAME_SIZE + (flames - 1) * FLAME_GAP;
    const rowTop = row - FLAME_SIZE / 2;
    const rowBottom = row + FLAME_SIZE / 2;
    const clearOfCopy = rowTop + FLAME_SIZE * FLAME_INK_TOP >= copyFoot(decided);
    const clearOfTotal = !keepBottom || rowBottom + PART_CLEARANCE <= bottomAt - half;
    const fitsCircle = span <= chordWidth(radius, rowTop, rowBottom);
    if (clearOfCopy && clearOfTotal && fitsCircle) layout.burn = burnRowAt(drawn, copy);
  }
  return layout;
}
