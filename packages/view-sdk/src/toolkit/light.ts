// THE LIGHT A CANVAS VIEW PAINTS STATE WITH (DESIGN §8), once for every view.
//
// Two views light a body by its state: the swarm into WebGPU and the timeline
// into a 2D context, and a blocked or unread body must glow the same in both.
// Neither can ask the engine for a custom property, so the palette's CSS
// arrives here as straight-alpha floats, and a state colour is taken three
// ways: as WORDS fit to be read on the theme's surface, as the LIGHT itself,
// and as the GROUND a lit body sits on. Ported unchanged from the swarm
// (`views/swarm/gpu/color.ts`, `swarm-theme.ts`); the timeline kept a
// parity-tested copy until MV-8 folded both here (M57).

/** A colour as straight-alpha floats, 0–1. */
export type Rgba = readonly [number, number, number, number];

export const TRANSPARENT: Rgba = [0, 0, 0, 0];

function channel(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) return Math.max(0, Math.min(1, Number.parseFloat(trimmed) / 100));
  const number = Number.parseFloat(trimmed);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number / 255)) : 0;
}

function alpha(value: string | undefined): number {
  if (value === undefined) return 1;
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) return Math.max(0, Math.min(1, Number.parseFloat(trimmed) / 100));
  const number = Number.parseFloat(trimmed);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1;
}

/** `#hex`, `rgb()`/`rgba()`, `color(srgb …)` or `transparent`; anything else is the engine's to resolve. */
export function parseCssColor(value: string): Rgba | undefined {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(text);
  if (hex) {
    const raw = hex[1]!;
    const digits =
      raw.length === 3 || raw.length === 4 ? [...raw].map((character) => character + character).join('') : raw;
    if (digits.length !== 6 && digits.length !== 8) return undefined;
    const number = Number.parseInt(digits, 16);
    if (!Number.isFinite(number)) return undefined;
    if (digits.length === 6)
      return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255, 1];
    return [
      ((number >>> 24) & 255) / 255,
      ((number >> 16) & 255) / 255,
      ((number >> 8) & 255) / 255,
      (number & 255) / 255,
    ];
  }
  const rgb = /^rgba?\(\s*([^)]+)\)$/iu.exec(text);
  if (rgb) {
    const [colour, slashAlpha] = rgb[1]!.split('/');
    const parts = colour!.split(/[\s,]+/u).filter(Boolean);
    if (parts.length < 3) return undefined;
    return [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!), alpha(slashAlpha ?? parts[3])];
  }
  const srgb = /^color\(srgb\s+([^)]+)\)$/iu.exec(text);
  if (srgb) {
    const [colour, slashAlpha] = srgb[1]!.split('/');
    const parts = colour!.split(/\s+/u).filter(Boolean);
    if (parts.length < 3) return undefined;
    return [
      Math.max(0, Math.min(1, Number.parseFloat(parts[0]!))),
      Math.max(0, Math.min(1, Number.parseFloat(parts[1]!))),
      Math.max(0, Math.min(1, Number.parseFloat(parts[2]!))),
      alpha(slashAlpha),
    ];
  }
  if (text === 'transparent') return TRANSPARENT;
  return undefined;
}

/**
 * Parse, or let the engine resolve it in `context` (the view's own root, never
 * the host's) and parse that, so the number is always the one the DOM would
 * paint: a token may be `color-mix()` or a name.
 */
export function resolveCssColor(value: string, context: Element | undefined): Rgba {
  const parsed = parseCssColor(value);
  if (parsed) return parsed;
  if (!context || typeof getComputedStyle !== 'function') return TRANSPARENT;
  const probe = context.ownerDocument.createElement('i');
  probe.style.color = value;
  probe.style.display = 'none';
  context.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return parseCssColor(resolved) ?? TRANSPARENT;
}

export function withAlpha(colour: Rgba, value: number): Rgba {
  return [colour[0], colour[1], colour[2], colour[3] * value];
}

/** Relative luminance, enough to tell a light ground from a dark one. */
export function luminance(colour: Rgba): number {
  return 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
}

/** A dark ink means a light theme. */
export function isLightTheme(ink: Rgba): boolean {
  return luminance(ink) < 0.5;
}

/** As a 2D context's `rgba()`: each channel to a byte, the alpha (times `alphaScale`) to four places. */
export function rgbaCss(colour: Rgba, alphaScale = 1): string {
  const byte = (value: number): number => Math.round(Math.max(0, Math.min(1, value)) * 255);
  return `rgba(${byte(colour[0])}, ${byte(colour[1])}, ${byte(colour[2])}, ${+(colour[3] * alphaScale).toFixed(4)})`;
}

/**
 * How hard a state colour burns, at the swarm's default tuning (its `stateChroma`, `stateGlowLift`,
 * `stateGroundLight`, `stateGroundDark`). The swarm passes its tuned values; the timeline lights at these.
 */
export interface StateLightTuning {
  /** How far each channel's distance from the brightest is scaled: chroma raised, hue and value held. */
  readonly chroma: number;
  /** A dark theme's light, carried this far toward white. */
  readonly glowLift: number;
  /** A light theme's ground, carried this far toward white. */
  readonly groundLight: number;
  /** A dark theme's ground, scaled by this toward black. */
  readonly groundDark: number;
}

export const DEFAULT_STATE_LIGHT: StateLightTuning = Object.freeze({
  chroma: 1.22,
  glowLift: 0.55,
  groundLight: 0.45,
  groundDark: 0.5,
});

/** How far a light theme darkens a state colour toward its ink to be read as words. */
export const STATE_TOWARD_INK = 0.45;

/**
 * A state colour fit to be READ on this theme's surface. The state hues are
 * tuned for a dark ground: on the light theme's surface orange measures 1.6:1
 * and blue 1.5:1, which is not text at any size, so a light theme darkens them
 * toward its ink until they carry (4.3:1 and 4.0:1) while the LIGHT inside a
 * body keeps the full hue. The dark theme needs neither: there the same hues
 * already measure about 7:1 (2026-09-18).
 */
export function readableColour(colour: Rgba, ink: Rgba, light: boolean): Rgba {
  if (!light) return colour;
  return [
    colour[0] * (1 - STATE_TOWARD_INK) + ink[0] * STATE_TOWARD_INK,
    colour[1] * (1 - STATE_TOWARD_INK) + ink[1] * STATE_TOWARD_INK,
    colour[2] * (1 - STATE_TOWARD_INK) + ink[2] * STATE_TOWARD_INK,
    colour[3],
  ];
}

/**
 * A state colour as the LIGHT it is, rather than the label it is elsewhere.
 * Scaling each channel's distance from the brightest one raises HSV saturation
 * while holding hue and value, so the already-saturated orange barely moves and
 * the pale blue gains real chroma. The kit's token stays the token; this is only
 * how it burns (2026-09-18).
 */
export function vividColour(colour: Rgba, chroma: number = DEFAULT_STATE_LIGHT.chroma): Rgba {
  const peak = Math.max(colour[0], colour[1], colour[2]);
  const lift = (value: number): number => Math.max(0, peak - (peak - value) * chroma);
  return [lift(colour[0]), lift(colour[1]), lift(colour[2]), colour[3]];
}

/**
 * The light itself, as against the ground it falls on. On a DARK theme it is
 * carried toward white, because against a dark ground brightness is what reads
 * as energy and a fully saturated hue only reads as paint. On a LIGHT theme the
 * hue at full chroma is already the hot end: the ground there is paler still, so
 * lifting the glow would put it on top of something it cannot out-brighten.
 */
export function stateGlow(
  hue: Rgba,
  light: boolean,
  tuning: Pick<StateLightTuning, 'glowLift'> = DEFAULT_STATE_LIGHT,
): Rgba {
  if (light) return hue;
  const lift = tuning.glowLift;
  return [hue[0] + (1 - hue[0]) * lift, hue[1] + (1 - hue[1]) * lift, hue[2] + (1 - hue[2]) * lift, hue[3]];
}

/**
 * The ground a lit body sits on: the same light carried toward this theme's own
 * paper, down toward black on a dark theme and up toward white on a light one.
 * The words live in the middle of a body, so the middle has to be the calm end
 * of the light rather than its hottest part. Carried by SCALING, not by mixing
 * toward the grey surface: mixing a saturated hue into grey is what turned the
 * dark theme's orange into a brown and its blue into slate.
 */
export function stateGround(
  hue: Rgba,
  light: boolean,
  tuning: Pick<StateLightTuning, 'groundLight' | 'groundDark'> = DEFAULT_STATE_LIGHT,
): Rgba {
  if (light) {
    const towardWhite = tuning.groundLight;
    return [
      hue[0] + (1 - hue[0]) * towardWhite,
      hue[1] + (1 - hue[1]) * towardWhite,
      hue[2] + (1 - hue[2]) * towardWhite,
      hue[3],
    ];
  }
  const dim = tuning.groundDark;
  return [hue[0] * dim, hue[1] * dim, hue[2] * dim, hue[3]];
}
