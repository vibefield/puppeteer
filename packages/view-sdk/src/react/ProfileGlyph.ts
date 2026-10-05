import { createElement, Fragment, type ReactElement } from 'react';
import { PROFILE_GLYPH_SHAPES, profileMarkName, type ProfileMarkName } from '../toolkit/marks.js';

/**
 * A profile set's mark (RFC 006 "Profile sets"): one monoline symbol on the
 * 20-unit grid, drawn FILLED when the set is the default for new sessions. The
 * native set — the providers' own roots — is always the laptop.
 *
 * The design record's "4 the glyph" (VibeField Agents settings, locked
 * 2026-09-22): users are colour, profiles are not, so a glyph takes the ink it
 * sits in and never a hue of its own. Its shapes are the toolkit's
 * (`PROFILE_GLYPH_SHAPES`), the one set every renderer draws from. Moved from
 * the views package (M6).
 */

function GlyphShape({ name }: { readonly name: ProfileMarkName }): ReactElement {
  return createElement(
    Fragment,
    null,
    PROFILE_GLYPH_SHAPES[name].map((shape, index) =>
      'd' in shape
        ? createElement('path', { key: index, d: shape.d })
        : createElement('rect', {
            key: index,
            x: shape.rect.x,
            y: shape.rect.y,
            width: shape.rect.width,
            height: shape.rect.height,
            rx: shape.rect.rx,
          }),
    ),
  );
}

export interface ProfileGlyphProps {
  /** The set's glyph token; ignored for the native set, which is always the laptop. */
  readonly glyph?: string | undefined;
  readonly kind?: 'native' | 'managed' | undefined;
  /** The default set for new sessions draws its glyph filled. */
  readonly filled?: boolean | undefined;
  /** Pixel size of the square; the stroke scales with it. */
  readonly size?: number | undefined;
  /** A label for a glyph that stands alone; absent, the glyph is decoration beside its name. */
  readonly title?: string | undefined;
  readonly className?: string | undefined;
}

export function ProfileGlyph({
  glyph,
  kind = 'managed',
  filled = false,
  size = 16,
  title,
  className,
}: ProfileGlyphProps): ReactElement {
  const name = profileMarkName(glyph, kind);
  return createElement(
    'svg',
    {
      viewBox: '0 0 20 20',
      width: size,
      height: size,
      className,
      fill: filled ? 'currentColor' : 'none',
      stroke: 'currentColor',
      strokeWidth: filled ? 1.1 : 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'data-profile-glyph': name,
      ...(title === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': title }),
    },
    createElement(GlyphShape, { name }),
  );
}
