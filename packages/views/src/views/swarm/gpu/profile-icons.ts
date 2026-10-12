import { PROFILE_GLYPH_SHAPES, profileGlyphMarkup, type ProfileMarkName } from '@vibefield/puppeteer-view-sdk/toolkit';

// A profile's mark in the swarm's atlas (`profile:<mark>[:filled]`, named by
// `bubble-model.ts` `profileIcon`), from ProfileGlyph's own shapes: the 20-unit
// grid scaled into the atlas's 24 box, never redrawn. The strokes are the
// prototype's canvas weights (1.7, and 1.3 under a fill), a touch heavier than
// the DOM's 1.5/1.1, which read faint at the ten pixels a body's line gives it.

export const PROFILE_ICON_PREFIX = 'profile:';

/** The mark's SVG for the atlas, or undefined for a mark this build does not draw. */
export function profileIconSvg(spec: string): string | undefined {
  const [mark = '', fill] = spec.split(':');
  if (!Object.hasOwn(PROFILE_GLYPH_SHAPES, mark)) return undefined;
  const paint =
    fill === 'filled'
      ? 'fill="currentColor" stroke="currentColor" stroke-width="1.3"'
      : 'fill="none" stroke="currentColor" stroke-width="1.7"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g transform="scale(1.2)" ${paint} stroke-linecap="round" stroke-linejoin="round">${profileGlyphMarkup(mark as ProfileMarkName)}</g></svg>`;
}
