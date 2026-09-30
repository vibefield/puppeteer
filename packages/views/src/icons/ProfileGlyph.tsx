import type { ReactElement } from 'react';

/**
 * A profile set's mark (RFC 006 "Profile sets"): one monoline symbol on the
 * 20-unit grid, suggested from the set's name and changeable, drawn FILLED
 * when the set is the default for new sessions. The native set — the
 * providers' own roots — is always the laptop.
 *
 * The design record's "4 the glyph" (VibeField Agents settings, locked
 * 2026-09-22): users are colour, profiles are not, so a glyph takes the ink it
 * sits in and never a hue of its own. Settings and the Godview profile tabs
 * draw from this one set.
 */

export const PROFILE_GLYPHS = [
  'briefcase',
  'house',
  'flask',
  'leaf',
  'bolt',
  'star',
  'moon',
  'cup',
  'rocket',
  'book',
  'gamepad',
] as const;

export type ProfileGlyphName = (typeof PROFILE_GLYPHS)[number];

/** The glyph a token names, or the fallback for a token this build does not draw. */
export function profileGlyphName(glyph: string | undefined): ProfileGlyphName {
  return (PROFILE_GLYPHS as readonly string[]).includes(glyph ?? '') ? (glyph as ProfileGlyphName) : 'star';
}

/** What a name is for, read from its words; first match wins. */
const SUGGESTIONS: ReadonlyArray<readonly [ProfileGlyphName, readonly string[]]> = [
  ['flask', ['demo', 'test', 'lab', 'experiment', 'sandbox', 'playground', 'trial', 'prototype', 'research']],
  ['briefcase', ['work', 'job', 'office', 'client', 'company', 'business', 'team', 'corp', 'consult', 'freelance']],
  ['house', ['home', 'personal', 'family', 'private', 'me', 'mine', 'own']],
  ['book', ['learn', 'study', 'school', 'course', 'class', 'read', 'docs', 'writing', 'notes']],
  ['gamepad', ['game', 'games', 'play', 'fun', 'hobby']],
  ['rocket', ['launch', 'startup', 'ship', 'side', 'project', 'venture']],
  ['bolt', ['fast', 'quick', 'urgent', 'prod', 'production', 'ops', 'deploy', 'power']],
  ['moon', ['night', 'late', 'weekend', 'evening', 'sleep']],
  ['cup', ['coffee', 'cafe', 'tea', 'break', 'morning']],
  ['leaf', ['garden', 'green', 'nature', 'eco', 'calm', 'open', 'oss', 'community']],
  ['star', ['star', 'favourite', 'favorite', 'main', 'primary', 'best']],
];

/**
 * The glyph a new set's name suggests: a word it recognises, else one picked
 * steadily from the name itself, so two unfamiliar names rarely share a mark
 * and the same name always suggests the same one.
 */
export function suggestProfileGlyph(label: string): ProfileGlyphName {
  const words = label
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
  for (const [glyph, cues] of SUGGESTIONS) {
    if (words.some((word) => cues.some((cue) => word === cue || (cue.length >= 4 && word.startsWith(cue))))) {
      return glyph;
    }
  }
  let hash = 0;
  for (const char of label.trim().toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return PROFILE_GLYPHS[hash % PROFILE_GLYPHS.length]!;
}

/** A mark's own name: one of the eleven tokens, or the native set's laptop. */
export type ProfileMarkName = ProfileGlyphName | 'laptop';

/** One shape of a mark on the 20-unit grid: a path, or a rounded box drawn as a `rect`. */
export type ProfileGlyphShape =
  | { readonly d: string }
  | {
      readonly rect: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
        readonly rx: number;
      };
    };

/**
 * Every mark's shapes on the 20-unit grid: what `ProfileGlyph` draws, and what
 * a renderer that rasterises its own copy draws from (the swarm's GPU atlas,
 * `gpu/swarm-renderer.ts`), so there is one set of paths and never a second.
 */
export const PROFILE_GLYPH_SHAPES: Readonly<Record<ProfileMarkName, readonly ProfileGlyphShape[]>> = {
  laptop: [{ rect: { x: 4, y: 4.5, width: 12, height: 8.5, rx: 1.6 } }, { d: 'M2.5 15.5h15' }],
  briefcase: [
    { rect: { x: 3, y: 7, width: 14, height: 9, rx: 2 } },
    { d: 'M7.5 7V5.5A1.5 1.5 0 0 1 9 4h2a1.5 1.5 0 0 1 1.5 1.5V7M3 11h14' },
  ],
  house: [{ d: 'M3.5 9.5 10 4l6.5 5.5V16h-13z' }, { d: 'M8.5 16v-4h3v4' }],
  flask: [{ d: 'M7.5 3.5h5M8.5 3.5v5.2l-4 6.8A1.2 1.2 0 0 0 5.5 17.3h9a1.2 1.2 0 0 0 1-1.8l-4-6.8V3.5M6.5 12.5h7' }],
  leaf: [{ d: 'M4 16c0-7 4-11 12-12-1 8-5 12-12 12Z' }, { d: 'm4 16 7-7' }],
  bolt: [{ d: 'M11 3 4.5 11.5H9.5L9 17l6.5-8.5h-5z' }],
  star: [{ d: 'm10 3.2 2 4.3 4.7.5-3.5 3.2 1 4.6L10 13.5l-4.2 2.3 1-4.6L3.3 8l4.7-.5z' }],
  moon: [{ d: 'M15.5 12.2A6.2 6.2 0 0 1 7.8 4.5a6.2 6.2 0 1 0 7.7 7.7Z' }],
  cup: [{ d: 'M4.5 7h9.5v4.5a4 4 0 0 1-4 4H8.5a4 4 0 0 1-4-4z' }, { d: 'M14 8.5h1a2 2 0 0 1 0 4h-1' }],
  rocket: [{ d: 'M10 3c3 2 4 6 3 9.5H7C6 8.5 7 5 10 3Z' }, { d: 'M7 12.5 4.5 15h3M13 12.5l2.5 2.5h-3M10 12.5V17' }],
  book: [
    { d: 'M4 4.5h5a2 2 0 0 1 2 2v9.5a1.5 1.5 0 0 0-1.5-1.5H4zM16 4.5h-5a2 2 0 0 0-2 2v9.5a1.5 1.5 0 0 1 1.5-1.5H16z' },
  ],
  gamepad: [
    { d: 'M6 6.5h8a4 4 0 0 1 4 4v1.5a3 3 0 0 1-5.4 1.8L12 13H8l-.6.8A3 3 0 0 1 2 12v-1.5a4 4 0 0 1 4-4Z' },
    { d: 'M6.5 9v3M5 10.5h3M13.5 10.5h.01' },
  ],
};

/** The mark a set draws: the laptop for the native set, else its token's (the star for one this build does not draw). */
export function profileMarkName(glyph: string | undefined, kind: 'native' | 'managed' | undefined): ProfileMarkName {
  return kind === 'native' ? 'laptop' : profileGlyphName(glyph);
}

/** A mark's shapes as SVG elements, for a renderer that builds its own `<svg>` round them. */
export function profileGlyphMarkup(name: ProfileMarkName): string {
  return PROFILE_GLYPH_SHAPES[name]
    .map((shape) =>
      'd' in shape
        ? `<path d="${shape.d}"/>`
        : `<rect x="${shape.rect.x}" y="${shape.rect.y}" width="${shape.rect.width}" height="${shape.rect.height}" rx="${shape.rect.rx}"/>`,
    )
    .join('');
}

function GlyphShape({ name }: { name: ProfileMarkName }): ReactElement {
  return (
    <>
      {PROFILE_GLYPH_SHAPES[name].map((shape, index) =>
        'd' in shape ? (
          <path key={index} d={shape.d} />
        ) : (
          <rect
            key={index}
            x={shape.rect.x}
            y={shape.rect.y}
            width={shape.rect.width}
            height={shape.rect.height}
            rx={shape.rect.rx}
          />
        ),
      )}
    </>
  );
}

export interface ProfileGlyphProps {
  /** The set's glyph token; ignored for the native set, which is always the laptop. */
  glyph?: string | undefined;
  kind?: 'native' | 'managed';
  /** The default set for new sessions draws its glyph filled. */
  filled?: boolean;
  /** Pixel size of the square; the stroke scales with it. */
  size?: number;
  /** A label for a glyph that stands alone; absent, the glyph is decoration beside its name. */
  title?: string;
  className?: string;
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
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 1.1 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-profile-glyph={name}
      {...(title === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': title })}
    >
      <GlyphShape name={name} />
    </svg>
  );
}
