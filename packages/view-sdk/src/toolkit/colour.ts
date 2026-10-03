import type { MonitorPalette, ProjectTint } from '../view.js';

// A PROJECT'S COLOUR, dealt from its sequence (design-system record §02),
// ported unchanged from the views package's `colour/project-tint.ts`.
//
// The backend deals each project a sequence the first time an agent runs in
// it (`MonitorProject.seq`); this file turns it into a colour. Only the hue is
// the project's: lightness and chroma are the theme's, so no project is louder
// than another. The hue is DEALT along the golden ratio rather than hashed
// from a path, because a hash clusters and the golden ratio keeps every prefix
// of the sequence spread. A 27° band around `--vf-select` is withheld so no
// project can be mistaken for the selection colour.
//
// The colour comes back as sRGB hex rather than `oklch()` because two consumers
// cannot ask the engine to resolve it: the swarm paints into a WebGPU canvas
// and the rain into a 2D context. Hosts build the replica's theme colour
// function from `projectColourFor` (L7), so views receive `AgentView.colour`
// ready and never call these themselves.

/** Where the dealing starts: the first project lands just past the withheld band. */
const TINT_HUE_0 = 258;
/** The withheld band: 27° from here, centred on `--vf-select` (252°). */
const TINT_SKIP_AT = 238;
const TINT_SKIP_WIDTH = 27;
/** The wheel less the band. */
const TINT_SPAN = 360 - TINT_SKIP_WIDTH;
const GOLDEN = 0.6180339887498949;

/** The record's own numbers, for a caller with no theme to read. */
export const DEFAULT_PROJECT_TINT: Readonly<Record<'light' | 'dark', ProjectTint>> = {
  light: { l: 0.6, c: 0.15 },
  dark: { l: 0.74, c: 0.15 },
};

/** `hue(seq) = (258 + seq · φ · 333) mod 333`, skipping the band. */
export function projectHue(seq: number): number {
  const position = (((TINT_HUE_0 + seq * GOLDEN * TINT_SPAN) % TINT_SPAN) + TINT_SPAN) % TINT_SPAN;
  return position < TINT_SKIP_AT ? position : position + TINT_SKIP_WIDTH;
}

/** The pane wheel starts half a golden turn on, so the first pane and the first project never share a hue. */
const PANE_WHEEL_OFFSET = 0.5;

/** The pane wheel: the same walk as the projects', a parallel sequence, offset so the two never start together. */
export function paneHue(seq: number): number {
  return projectHue(seq + PANE_WHEEL_OFFSET);
}

function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

/** OKLCH → linear sRGB, unclamped, so a caller can tell an out-of-gamut colour. */
function oklchToLinearSrgb(l: number, c: number, hueDegrees: number): [number, number, number] {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const cubeL = l_ * l_ * l_;
  const cubeM = m_ * m_ * m_;
  const cubeS = s_ * s_ * s_;
  return [
    4.0767416621 * cubeL - 3.3077115913 * cubeM + 0.2309699292 * cubeS,
    -1.2684380046 * cubeL + 2.6097574011 * cubeM - 0.3413193965 * cubeS,
    -0.0041960863 * cubeL - 0.7034186147 * cubeM + 1.707614701 * cubeS,
  ];
}

const GAMUT_EPSILON = 0.0005;

function inGamut(rgb: readonly number[]): boolean {
  return rgb.every((channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON);
}

/**
 * The sRGB hex for one OKLCH colour. A hue the theme's chroma cannot reach in
 * sRGB keeps its hue and lightness and gives up chroma until it fits, which is
 * what the engine does for the same `oklch()` text, so the record's page and
 * the app agree on every project.
 */
export function oklchToHex(l: number, c: number, hueDegrees: number): string {
  let rgb = oklchToLinearSrgb(l, c, hueDegrees);
  if (!inGamut(rgb)) {
    let low = 0;
    let high = c;
    for (let step = 0; step < 24; step += 1) {
      const middle = (low + high) / 2;
      const candidate = oklchToLinearSrgb(l, middle, hueDegrees);
      if (inGamut(candidate)) {
        low = middle;
        rgb = candidate;
      } else high = middle;
    }
  }
  return `#${rgb
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, linearToSrgb(Math.max(0, Math.min(1, channel))))) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The colour of project `seq` under the theme's tint. */
export function projectColour(seq: number, tint: ProjectTint): string {
  return oklchToHex(tint.l, tint.c, projectHue(seq));
}

/** A pane's colour, dealt from its sequence on the pane wheel under the theme's tint. */
export function paneColour(seq: number, tint: ProjectTint): string {
  return oklchToHex(tint.l, tint.c, paneHue(seq));
}

/**
 * The theme's colour function (L7): a project's dealt colour, or the neutral
 * ramp for a row in no project or one not dealt yet. Each sequence is worked
 * out once per theme, so a host rebuilds this when the theme's key changes and
 * hands it to the replica, which re-colours rows only then.
 */
export function projectColourFor(
  palette: Pick<MonitorPalette, 'tint' | 'neutral'>,
): (seq: number | undefined) => string {
  const tint: ProjectTint = { l: palette.tint.l, c: palette.tint.c };
  const dealt = new Map<number, string>();
  return (seq) => {
    if (seq === undefined) return palette.neutral;
    let colour = dealt.get(seq);
    if (colour === undefined) {
      colour = projectColour(seq, tint);
      dealt.set(seq, colour);
    }
    return colour;
  };
}

/** `#rrggbb` (or `#rgb`) as the `"r, g, b"` channels a canvas `rgba()` wants; `0, 0, 0` for anything else. */
export function hexToRgb255(hex: string): string {
  const raw = hex.trim().replace(/^#/, '');
  const expanded = raw.length === 3 ? raw.replace(/./g, (char) => char + char) : raw;
  const value = Number.parseInt(expanded.slice(0, 6), 16);
  if (!Number.isFinite(value) || expanded.length < 6) return '0, 0, 0';
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}
