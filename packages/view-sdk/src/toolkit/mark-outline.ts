// A VIEW'S MARK AS FILLED PATHS (MV-D6). The host's bar draws `manifest.mark`
// filled in currentColor and never strokes it: a stroked outline draws both of
// its edges (the house practice, Phosphor's filled outlines). A monoline mark,
// drawn on the bar's 24-unit grid with 1.6 strokes and round caps, is authored
// here as the outline its stroke would paint, so the filled path paints the
// same pixels the bar's stroked marks did until MV-8 ruled fill.

/** The bar's mark grid: a mark's `viewBox` is `0 0 24 24`. */
export const MARK_VIEW_BOX = '0 0 24 24';

/** The bar's monoline weight, in grid units (drawn at 12 px, so 0.8 px). */
export const MARK_STROKE = 1.6;

export type MarkPoint = readonly [x: number, y: number];

/** A coordinate to four places, with no `-0`: the same mark always writes the same text. */
function unit(value: number): string {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** A disc of radius `r` as one subpath, wound counter-clockwise on screen (`sweep` 0) or clockwise (1). */
function disc(cx: number, cy: number, r: number, sweep: 0 | 1): string {
  const radius = `${unit(r)} ${unit(r)}`;
  return (
    `M${unit(cx - r)} ${unit(cy)}A${radius} 0 1 ${sweep} ${unit(cx + r)} ${unit(cy)}` +
    `A${radius} 0 1 ${sweep} ${unit(cx - r)} ${unit(cy)}Z`
  );
}

/** A straight stroke from `from` to `to` with round caps, as the filled outline it paints. */
export function strokeOutline(from: MarkPoint, to: MarkPoint, width: number = MARK_STROKE): string {
  const half = width / 2;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return disc(from[0], from[1], half, 0);
  // One side of the stroke, half its width off the line.
  const nx = (-dy / length) * half;
  const ny = (dx / length) * half;
  const cap = `${unit(half)} ${unit(half)} 0 0 0`;
  return (
    `M${unit(from[0] + nx)} ${unit(from[1] + ny)}L${unit(to[0] + nx)} ${unit(to[1] + ny)}` +
    `A${cap} ${unit(to[0] - nx)} ${unit(to[1] - ny)}L${unit(from[0] - nx)} ${unit(from[1] - ny)}` +
    `A${cap} ${unit(from[0] + nx)} ${unit(from[1] + ny)}Z`
  );
}

/** Several strokes as one path, each its own subpath (they must not cross: each is filled on its own). */
export function strokesOutline(strokes: readonly (readonly [MarkPoint, MarkPoint])[], width?: number): string {
  return strokes.map(([from, to]) => strokeOutline(from, to, width)).join('');
}

/** A stroked circle as the filled ring it paints: the outer edge, and the inner one wound the other way (a hole). */
export function ringOutline(cx: number, cy: number, r: number, width: number = MARK_STROKE): string {
  const half = width / 2;
  // A circle no wider than its stroke paints a disc: there is no hole left to wind.
  return disc(cx, cy, r + half, 0) + (r > half ? disc(cx, cy, r - half, 1) : '');
}
