import type { Rgba } from '@vibefield/puppeteer-view-sdk/toolkit';

// One glyph instance as the text pass reads it (`shaders/text.wgsl`, `struct Glyph`), packed on the CPU so what each
// quad asks of the shader is held by a test, the GPU being out of reach there.

/** Floats per glyph instance: rect, uv, colour, params. */
export const GLYPH_FLOATS = 16;

/**
 * What the text pass reads for a quad, its `params.x`:
 * - `coverage`: the glyph atlas's alpha, tinted by the instance (type, and the sprites drawn white);
 * - `field`: the vendor marks' signed distance, tinted by the instance;
 * - `colour`: the glyph atlas's own premultiplied colours, faded by the instance's alpha alone (a host's colour
 *   picture, `HostMark`).
 */
export const GLYPH_MODE = { coverage: 0, field: 1, colour: 2 } as const;
export type GlyphMode = (typeof GLYPH_MODE)[keyof typeof GLYPH_MODE];

export interface PackedGlyph {
  /** x, y, width, height, CSS px. */
  rect: readonly [number, number, number, number];
  /** u0, v0, u1, v1. */
  uv: readonly [number, number, number, number];
  colour: Rgba;
  alpha: number;
  mode: GlyphMode;
  /** The field's px range on screen, for `field` alone. */
  pxRange?: number;
}

/** Writes one glyph instance at `offset` (in floats). */
export function packGlyph(target: Float32Array, offset: number, glyph: PackedGlyph): void {
  target[offset] = glyph.rect[0];
  target[offset + 1] = glyph.rect[1];
  target[offset + 2] = glyph.rect[2];
  target[offset + 3] = glyph.rect[3];
  target[offset + 4] = glyph.uv[0];
  target[offset + 5] = glyph.uv[1];
  target[offset + 6] = glyph.uv[2];
  target[offset + 7] = glyph.uv[3];
  target[offset + 8] = glyph.colour[0];
  target[offset + 9] = glyph.colour[1];
  target[offset + 10] = glyph.colour[2];
  target[offset + 11] = glyph.colour[3] * glyph.alpha;
  target[offset + 12] = glyph.mode;
  target[offset + 13] = glyph.mode === GLYPH_MODE.field ? (glyph.pxRange ?? 0) : 0;
  target[offset + 14] = 0;
  target[offset + 15] = 0;
}

/** A host's stencil picture as the atlas's sprites are written: its path in the marks' 24-unit box, `currentColor`. */
export function stencilSvg(path: string): string {
  const d = path.replaceAll('"', '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}" fill="currentColor"/></svg>`;
}

/**
 * Where a host's rim picture (`HostMark.rim`) sits on a body: at the rim's 45° point, up and to the right of the
 * centre, on a disc a little over a third of the radius across (12 to 22 CSS px), the picture inside it.
 */
export function rimPlacement(
  cx: number,
  cy: number,
  radius: number,
): { x: number; y: number; disc: number; picture: number } {
  const disc = Math.max(12, Math.min(22, Math.round(radius * 0.36)));
  const reach = radius * Math.SQRT1_2;
  return { x: cx + reach, y: cy - reach, disc, picture: Math.round(disc * 0.72) };
}
