import { describe, expect, it } from 'vitest';
import { GLYPH_FLOATS, GLYPH_MODE, packGlyph, rimPlacement, stencilSvg } from './glyph-pack.js';

// What each quad asks of the text pass (`shaders/text.wgsl`), held here: the GPU is out of reach of a test. The colour
// mode is the shader's third reading of the atlas; its WGSL is read, and first run on a GPU by a host's still frames.

const INK = [0.1, 0.2, 0.3, 0.5] as const;

function packed(glyph: Parameters<typeof packGlyph>[2]): number[] {
  const target = new Float32Array(GLYPH_FLOATS);
  packGlyph(target, 0, glyph);
  return [...target].map((value) => Math.round(value * 1000) / 1000);
}

describe('a glyph instance', () => {
  const base = { rect: [1, 2, 3, 4], uv: [0.1, 0.2, 0.3, 0.4], colour: INK, alpha: 0.5 } as const;

  it('packs the rect, the uv, the colour with its alpha, and the mode the shader reads in params.x', () => {
    expect(packed({ ...base, mode: GLYPH_MODE.coverage })).toEqual([
      1, 2, 3, 4, 0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.25, 0, 0, 0, 0,
    ]);
  });

  it("carries the field's px range for a vendor mark alone", () => {
    expect(packed({ ...base, mode: GLYPH_MODE.field, pxRange: 6 }).slice(12)).toEqual([1, 6, 0, 0]);
    expect(packed({ ...base, mode: GLYPH_MODE.coverage, pxRange: 6 }).slice(12)).toEqual([0, 0, 0, 0]);
  });

  it("asks for a host's colour picture's own colours with mode 2, faded by the instance's alpha", () => {
    expect(packed({ ...base, mode: GLYPH_MODE.colour }).slice(11)).toEqual([0.25, 2, 0, 0, 0]);
  });
});

describe("a host's picture on the GPU", () => {
  it("writes a stencil as the atlas's sprites are written, in currentColor in the 24-unit box", () => {
    expect(stencilSvg('M4 4h16v16H4z')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="currentColor"/></svg>',
    );
    // a path cannot close its own attribute
    expect(stencilSvg('M0 0"/><script/>')).not.toContain('"/><script');
  });

  it("sits a rim picture at the rim's 45° point, on a disc a third of the radius across, between 12 and 22 px", () => {
    const at = rimPlacement(100, 100, 40);
    expect([Math.round(at.x * 100) / 100, Math.round(at.y * 100) / 100]).toEqual([128.28, 71.72]);
    expect(at).toMatchObject({ disc: 14, picture: 10 });
    expect(rimPlacement(0, 0, 10).disc).toBe(12);
    expect(rimPlacement(0, 0, 200).disc).toBe(22);
  });
});
