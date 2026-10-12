import { oklchToHex, parseCssColor, type Rgba } from '@vibefield/puppeteer-view-sdk/toolkit';

// Two inks the spend view derives from a row's project colour, so nothing new
// crosses the seam (SV-D4): a sibling's TONE — the second agent born in a
// project a step darker, the third a step lighter, so three rosetta lines can
// be told apart while all three read as rosetta — and a FILL, the hue lifted
// so the ink's own text reads on it (the tag at a pointed head). The host's
// colour is kept as it is for the first. Ported from the prototype's
// `SV.ink.tone` and `SV.ink.fill` (`draft/godview-spend/site/sv-core.js`).

/** The lightness step per sibling, in OKLCH L: the first keeps the host's colour. */
const TONE_STEP = { light: [0, -0.1, 0.1], dark: [0, -0.1, 0.08] } as const;

const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);

/** sRGB (0–1) to OKLCH: lightness, chroma, hue in degrees. */
export function rgbToOklch(colour: Rgba): { l: number; c: number; h: number } {
  const r = toLinear(colour[0]);
  const g = toLinear(colour[1]);
  const b = toLinear(colour[2]);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

/** The sibling's tone of a project colour: `sib` 0 is the colour itself, 1 a step darker, 2 and on a step lighter. */
export function siblingTone(colour: Rgba, sib: number, dark: boolean): Rgba {
  if (sib <= 0) return colour;
  const { l, c, h } = rgbToOklch(colour);
  const step = TONE_STEP[dark ? 'dark' : 'light'][Math.min(sib, 2)]!;
  return parseCssColor(oklchToHex(Math.min(0.9, Math.max(0.3, l + step)), c, h)) ?? colour;
}

/** The colour lifted to a light fill its own dark text reads on, in both themes. */
export function liftedFill(colour: Rgba, sib: number): string {
  const { h } = rgbToOklch(colour);
  return oklchToHex(0.83 - Math.min(sib, 2) * 0.035, 0.085, h);
}

/** Siblings by birth: the order each agent was born in among its project's priced agents. */
export function siblingIndex(rows: readonly { id: string; project: string; bornMs: number }[]): Map<string, number> {
  const seen = new Map<string, number>();
  const out = new Map<string, number>();
  for (const row of [...rows].sort((a, b) => a.bornMs - b.bornMs || (a.id < b.id ? -1 : 1))) {
    const n = seen.get(row.project) ?? 0;
    out.set(row.id, n);
    seen.set(row.project, n + 1);
  }
  return out;
}
