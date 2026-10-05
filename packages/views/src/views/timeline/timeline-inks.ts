import type { MonitorPalette } from '@vibecook/puppeteer-view-sdk';

// The palette resolved to the numbers a 2D context wants, once per theme. The
// timeline's bodies are lit as the swarm lights them (DESIGN §8), so the state
// lights are the swarm's own: its orange and blue at full chroma for the light,
// darkened toward the ink to be read as words on a light theme, and carried to
// this theme's paper for the ground a lit body sits on.
//
// The rules are the swarm's (`views/swarm/swarm-theme.ts` and `gpu/color.ts`,
// at the swarm's default tuning), copied here because a view imports nothing
// outside its own folder but the SDK (MV-W1) and those files are the swarm's.
// `legacy/timeline-parity.test.tsx` holds this copy equal to the swarm's.

/** A colour as straight-alpha floats, 0–1. */
export type Rgba = readonly [number, number, number, number];

const TRANSPARENT: Rgba = [0, 0, 0, 0];

/** The swarm's tuning these lights are taken at (`DEFAULT_SWARM_PARAMETERS`). */
const STATE_CHROMA = 1.22;
const STATE_GROUND_LIGHT = 0.45;
const STATE_GROUND_DARK = 0.5;
/** How far a light theme darkens a state colour toward its ink to be read as words. */
const TOWARD_INK = 0.45;

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

/** Parse, or let the engine resolve it in `context` (the view's own root) and parse that. */
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

/** Relative luminance, enough to tell a light ground from a dark one. */
export function luminance(colour: Rgba): number {
  return 0.2126 * colour[0] + 0.7152 * colour[1] + 0.0722 * colour[2];
}

/** A state colour fit to be read on this theme's surface: a light theme darkens it toward its ink. */
function readable(colour: Rgba, ink: Rgba, light: boolean): Rgba {
  if (!light) return colour;
  return [
    colour[0] * (1 - TOWARD_INK) + ink[0] * TOWARD_INK,
    colour[1] * (1 - TOWARD_INK) + ink[1] * TOWARD_INK,
    colour[2] * (1 - TOWARD_INK) + ink[2] * TOWARD_INK,
    colour[3],
  ];
}

/** A state colour as the light it is: each channel's distance from the brightest scaled, hue and value held. */
function vivid(colour: Rgba): Rgba {
  const peak = Math.max(colour[0], colour[1], colour[2]);
  const lift = (value: number): number => Math.max(0, peak - (peak - value) * STATE_CHROMA);
  return [lift(colour[0]), lift(colour[1]), lift(colour[2]), colour[3]];
}

/** The ground a lit body sits on: the light carried toward white on a light theme, scaled toward black on a dark one. */
function stateGround(hue: Rgba, light: boolean): Rgba {
  if (light) {
    return [
      hue[0] + (1 - hue[0]) * STATE_GROUND_LIGHT,
      hue[1] + (1 - hue[1]) * STATE_GROUND_LIGHT,
      hue[2] + (1 - hue[2]) * STATE_GROUND_LIGHT,
      hue[3],
    ];
  }
  return [hue[0] * STATE_GROUND_DARK, hue[1] * STATE_GROUND_DARK, hue[2] * STATE_GROUND_DARK, hue[3]];
}

/** The palette resolved to the numbers a 2D context wants, once per theme. */
export interface TimelineInks {
  readonly dark: boolean;
  readonly ground: Rgba;
  readonly ink: Rgba;
  readonly muted: Rgba;
  readonly faint: Rgba;
  readonly border: Rgba;
  readonly grid: Rgba;
  /** The swarm's state lights, at full chroma. */
  readonly orange: Rgba;
  readonly blue: Rgba;
  /** The same two, fit to be read as words on this theme's ground. */
  readonly orangeInk: Rgba;
  readonly blueInk: Rgba;
  /** The ground a lit body's light falls on (its outer ring). */
  readonly orangeGround: Rgba;
  readonly blueGround: Rgba;
  /** A project colour, resolved in the view's own cascade (a host may hand `var()`). */
  project(color: string): Rgba;
}

export function css(colour: Rgba, alphaScale = 1): string {
  const byte = (value: number): number => Math.round(Math.max(0, Math.min(1, value)) * 255);
  return `rgba(${byte(colour[0])}, ${byte(colour[1])}, ${byte(colour[2])}, ${+(colour[3] * alphaScale).toFixed(4)})`;
}

export function resolveTimelineInks(palette: MonitorPalette, context: Element | undefined): TimelineInks {
  const resolve = (value: string): Rgba => resolveCssColor(value, context);
  const ink = resolve(palette.swarm.ink);
  // A dark ink means a light theme.
  const light = luminance(ink) < 0.5;
  const orange = resolve(palette.swarm.orange);
  const blue = resolve(palette.swarm.blue);
  const projects = new Map<string, Rgba>();
  return {
    dark: !light,
    ground: resolve(palette.timeline.ground),
    ink,
    muted: resolve(palette.timeline.muted),
    faint: resolve(palette.neutral),
    border: resolve(palette.timeline.border),
    grid: resolve(palette.swarm.gridLine),
    orange,
    blue,
    orangeInk: readable(orange, ink, light),
    blueInk: readable(blue, ink, light),
    orangeGround: stateGround(vivid(orange), light),
    blueGround: stateGround(vivid(blue), light),
    project(color) {
      let resolved = projects.get(color);
      if (!resolved) {
        resolved = resolve(color);
        projects.set(color, resolved);
      }
      return resolved;
    },
  };
}
