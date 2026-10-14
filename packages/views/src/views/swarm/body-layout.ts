import { COPY_ONE_LINE, type SwarmBubbleModel } from './bubble-model.js';
import {
  ladderCopy,
  layoutCopy,
  type CopyLayout,
  type CopyLine,
  type TextMeasure,
  type TextStyle,
} from './text-layout.js';

// Where everything a body draws stands, and which of it the body keeps. Pure,
// so what each radius draws is testable with a fake measurer; the renderer
// draws the answer and decides nothing about it.
//
// The words step down as bodies shrink, on three rungs (SWF; James 2026-10-13:
// "full → name + tool → name only"):
//
// 1. FULL, at or above `RUNG_FULL` (the smallest base radius, so every body at
//    the crowd's scale 1 draws exactly what it drew): every line, the context
//    figure, the total and the burn row, the watermark at today's sizes.
// 2. NAME + ONE LINE, from `RUNG_NAME_ONLY` up to it: the name and the line
//    `COPY_ONE_LINE` picks (the state line, else the model line, else a
//    terminal's word). The branch, a terminal's clock, profile and host, both
//    figures and the burn row go; the watermark takes its small size.
// 3. NAME ONLY, below `RUNG_NAME_ONLY`.
//
// Within a rung each line is fitted to its chord, and a line cut below a
// legible stub goes too (`ladderCopy`), the name never. The fewer lines a rung
// keeps, the nearer its stack stands to the centre, so the name gets the
// widest chord. The context RING is the rim's, and is drawn at every rung.
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
/** The provider's mark behind the copy: its size, and its small size on a small or stepped-down body. */
export const WATERMARK_SIZE = 58;
export const WATERMARK_SMALL = 46;
/** A full body drawn this small or smaller (an arrival's first frames) wears the small watermark, as it always did. */
const WATERMARK_SMALL_AT = 40;

/**
 * At or above this eased radius a body draws everything: the smallest base radius (idle and blocked, 50), so a
 * crowd at scale 1 is drawn exactly as before the fit.
 */
export const RUNG_FULL = 50;
/**
 * Below this a body draws its name alone. Between the grid's sizes for an idle body (50 × k on k's 0.04 grid: …,
 * 34, 36, …) rather than on one, so a body easing to its size never crosses it at the spring's last frame: an idle
 * body at 0.72 (36) keeps its one line, at 0.68 (34) its name.
 */
export const RUNG_NAME_ONLY = 35;

export type BodyRung = 'full' | 'one-line' | 'name';

export interface BodyLayout {
  /** The rung the eased radius chose. */
  rung: BodyRung;
  /** The kept copy, fitted at the drawn radius. */
  copy: CopyLayout;
  /** The watermark's size, CSS px, before a working body's breath. */
  watermark: number;
  /** Centre of each part drawn, relative to the body's centre (down positive); absent where it is not drawn. */
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

/** Which rung a body at this eased radius stands on. */
export function bodyRung(radius: number): BodyRung {
  if (radius >= RUNG_FULL) return 'full';
  return radius >= RUNG_NAME_ONLY ? 'one-line' : 'name';
}

/** How many flames the burn row draws: the lit ones, or one hollow flame where nothing prices the work. */
export function burnFlamesDrawn(model: SwarmBubbleModel): number {
  const burn = model.burn;
  if (!burn) return 0;
  return burn.priced ? burn.lit : 1;
}

/** The burn row's centre: midway between a margin under the model line and a margin above the total figure, so
 * the flames stand where the chart used to, whatever the radius. */
function burnRowAt(radius: number, copy: CopyLayout): number {
  const modelLine = copy.lines.find((line) => line.key === 'model');
  const under = modelLine ? modelLine.y + modelLine.height / 2 : copy.bottom;
  const top = under + BAND_MARGIN_TOP;
  const floor = Math.max(top + 4, radius - FIGURE_MARGIN - FIGURE_STYLE.size - BAND_MARGIN_BOTTOM);
  return (top + floor) / 2;
}

const figureInset = FIGURE_MARGIN + FIGURE_STYLE.size / 2;

/** The lines a stepped-down rung keeps, in the copy's own order: the name, and on the middle rung its one line.
 * The first kept line loses the gap it had under a line that is gone. */
function rungLines(copy: readonly CopyLine[], rung: Exclude<BodyRung, 'full'>): CopyLine[] {
  const one = rung === 'one-line' ? COPY_ONE_LINE.find((key) => copy.some((line) => line.key === key)) : undefined;
  const kept = copy.filter((line) => line.key === 'name' || line.key === one);
  return kept.map((line, index) => (index === 0 && line.gapBefore ? { ...line, gapBefore: 0 } : line));
}

export function bodyLayout(model: SwarmBubbleModel, options: BodyLayoutOptions): BodyLayout {
  const { radius, measure } = options;
  const scale = options.scale ?? 1;
  const drawn = radius * scale;
  const maxWidthRatio = model.copyMaxWidthRatio;
  const rung = bodyRung(radius);

  if (rung === 'full') {
    // Exactly what a body drew before the ladder: every line, both figures, the burn row.
    const copy = layoutCopy(model.copy, { radius: drawn, measure, maxWidthRatio });
    const layout: BodyLayout = {
      rung,
      copy,
      watermark: drawn <= WATERMARK_SMALL_AT ? WATERMARK_SMALL : WATERMARK_SIZE,
    };
    if (model.figures?.top) layout.top = -drawn + figureInset;
    if (model.figures?.bottom) layout.bottom = drawn - figureInset;
    if (burnFlamesDrawn(model) > 0) layout.burn = burnRowAt(drawn, copy);
    return layout;
  }

  // Stepped down: the rung's lines, any of them cut below a legible stub dropped (the name never), decided at
  // the eased radius and fitted at the drawn one.
  const lines = rungLines(model.copy, rung);
  const decided = ladderCopy(lines, { radius, measure, maxWidthRatio, order: COPY_ONE_LINE });
  const kept = lines.filter((line) => decided.lines.some((placed) => placed.key === line.key));
  const copy = scale === 1 ? decided : layoutCopy(kept, { radius: drawn, measure, maxWidthRatio });
  return { rung, copy, watermark: WATERMARK_SMALL };
}
