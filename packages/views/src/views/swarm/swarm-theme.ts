import type { SwarmPalette } from '@vibecook/puppeteer-view-sdk';
import { DEFAULT_SWARM_PARAMETERS, type SwarmParameters } from './swarm-parameters.js';
import { luminance, resolveCssColor, type Rgba } from './gpu/color.js';
import type { SwarmTheme } from './gpu/swarm-renderer.js';

/**
 * The palette arrives as CSS; the GPU wants numbers. Resolved in `context`'s
 * own cascade so any syntax the tokens use resolves the way the DOM would
 * paint it. Shared by the view and the design lab, so both draw one theme.
 *
 * Two colours carry the whole greyscale: the surface every body wears and the
 * ink every mark is drawn in. `weight.ts` holds the ladder between them.
 */
/**
 * A state colour fit to be READ on this theme's surface.
 *
 * The state hues are tuned for a dark ground: on the light theme's surface,
 * orange measures 1.6:1 and blue 1.5:1 against it, which is not text at any
 * size. A light theme therefore darkens them toward its own ink until they
 * carry — 4.3:1 and 4.0:1 — while the LIGHT inside a body keeps the full hue,
 * because a glow is supposed to be bright. The dark theme needs neither: there
 * the same hues already measure about 7:1 (2026-09-18).
 */
function readable(colour: Rgba, ink: Rgba, light: boolean): Rgba {
  if (!light) return colour;
  const towardInk = 0.45;
  return [
    colour[0] * (1 - towardInk) + ink[0] * towardInk,
    colour[1] * (1 - towardInk) + ink[1] * towardInk,
    colour[2] * (1 - towardInk) + ink[2] * towardInk,
    colour[3],
  ];
}

/**
 * A state colour as the LIGHT it is, rather than the label it is elsewhere.
 * Scaling each channel's distance from the brightest one raises HSV saturation
 * while holding hue and value, so the already-saturated orange barely moves and
 * the pale blue gains real chroma. The kit's token stays the token; this is only
 * how the swarm burns it (2026-09-18), and `stateChroma` tunes how hard.
 */
function vivid(colour: Rgba, chroma: number): Rgba {
  const peak = Math.max(colour[0], colour[1], colour[2]);
  const lift = (channel: number): number => Math.max(0, peak - (peak - channel) * chroma);
  return [lift(colour[0]), lift(colour[1]), lift(colour[2]), colour[3]];
}

/**
 * The light itself, as against the ground it falls on. On a DARK theme it is
 * carried toward white, because against a dark ground brightness is what reads
 * as energy and a fully saturated hue only reads as paint. On a LIGHT theme the
 * hue at full chroma is already the hot end: the ground there is paler still, so
 * lifting the glow would put it on top of something it cannot out-brighten.
 */
function stateGlow(hue: Rgba, light: boolean, parameters: SwarmParameters): Rgba {
  if (light) return hue;
  const lift = parameters.stateGlowLift;
  return [hue[0] + (1 - hue[0]) * lift, hue[1] + (1 - hue[1]) * lift, hue[2] + (1 - hue[2]) * lift, hue[3]];
}

/**
 * The ground a glowing body sits on: the same light carried toward this theme's
 * own paper, down toward black on a dark theme and up toward white on a light
 * one. The words live in the middle of a body, so the middle has to be the calm
 * end of the light rather than its hottest part.
 *
 * Carried by SCALING, not by mixing toward the grey surface. Mixing a saturated
 * hue into grey is what turned the dark theme's orange into a brown and its blue
 * into slate; scaling holds the hue exactly and only spends its brightness.
 */
function stateGround(glow: Rgba, light: boolean, parameters: SwarmParameters): Rgba {
  if (light) {
    const towardWhite = parameters.stateGroundLight;
    return [
      glow[0] + (1 - glow[0]) * towardWhite,
      glow[1] + (1 - glow[1]) * towardWhite,
      glow[2] + (1 - glow[2]) * towardWhite,
      glow[3],
    ];
  }
  const dim = parameters.stateGroundDark;
  return [glow[0] * dim, glow[1] * dim, glow[2] * dim, glow[3]];
}

export function resolveSwarmTheme(
  palette: SwarmPalette,
  context: Element | undefined,
  parameters: SwarmParameters = DEFAULT_SWARM_PARAMETERS,
): SwarmTheme {
  const resolve = (value: string): Rgba => resolveCssColor(value, context);
  const ink = resolve(palette.ink);
  // A dark ink means a light theme, and a light theme casts a black shadow.
  const light = luminance(ink) < 0.5;
  const surface = resolve(palette.surface);
  const orange = resolve(palette.orange);
  const green = resolve(palette.green);
  const blue = resolve(palette.blue);
  // The two states that light a body up. One hue each, taken to the hot end for
  // the light and to the calm end for the ground it falls on.
  const orangeHue = vivid(orange, parameters.stateChroma);
  const blueHue = vivid(blue, parameters.stateChroma);
  return {
    surface,
    ink,
    grid: resolve(palette.gridLine),
    orange,
    green,
    blue,
    // The same three, fit to be read as words and marks on this theme's surface.
    stateInk: {
      orange: readable(orange, ink, light),
      green: readable(green, ink, light),
      blue: readable(blue, ink, light),
    },
    // The light a blocked or unread body gives, and the ground it gives it over.
    stateGlow: {
      orange: stateGlow(orangeHue, light, parameters),
      blue: stateGlow(blueHue, light, parameters),
    },
    stateGround: {
      orange: stateGround(orangeHue, light, parameters),
      blue: stateGround(blueHue, light, parameters),
    },
    // agent-bubble.css's pre-blurred layers: black on light, white on dark.
    shadow: light ? [0, 0, 0, 0.18] : [1, 1, 1, 0.12],
    shadowPeak: light ? [0, 0, 0, 0.34] : [1, 1, 1, 0.3],
  };
}
