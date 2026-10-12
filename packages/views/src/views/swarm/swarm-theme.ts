import type { SwarmPalette } from '@vibefield/puppeteer-view-sdk';
import {
  isLightTheme,
  readableColour,
  resolveCssColor,
  stateGlow,
  stateGround,
  vividColour,
  type Rgba,
  type StateLightTuning,
} from '@vibefield/puppeteer-view-sdk/toolkit';
import { DEFAULT_SWARM_PARAMETERS, type SwarmParameters } from './swarm-parameters.js';
import type { SwarmTheme } from './gpu/swarm-renderer.js';

/**
 * The palette arrives as CSS; the GPU wants numbers. Resolved in `context`'s
 * own cascade so any syntax the tokens use resolves the way the DOM would
 * paint it. Shared by the view and the design lab, so both draw one theme.
 *
 * Two colours carry the whole greyscale: the surface every body wears and the
 * ink every mark is drawn in. `weight.ts` holds the ladder between them. The
 * state colours are lit by the toolkit's light (`/toolkit` light.ts), the same
 * rules the timeline lights its bodies with, at this view's tuning.
 */

/** The swarm's tuning of the toolkit's state light. */
function lightTuning(parameters: SwarmParameters): StateLightTuning {
  return {
    chroma: parameters.stateChroma,
    glowLift: parameters.stateGlowLift,
    groundLight: parameters.stateGroundLight,
    groundDark: parameters.stateGroundDark,
  };
}

export function resolveSwarmTheme(
  palette: SwarmPalette,
  context: Element | undefined,
  parameters: SwarmParameters = DEFAULT_SWARM_PARAMETERS,
): SwarmTheme {
  const resolve = (value: string): Rgba => resolveCssColor(value, context);
  const tuning = lightTuning(parameters);
  const ink = resolve(palette.ink);
  // A dark ink means a light theme, and a light theme casts a black shadow.
  const light = isLightTheme(ink);
  const surface = resolve(palette.surface);
  const orange = resolve(palette.orange);
  const green = resolve(palette.green);
  const blue = resolve(palette.blue);
  // The two states that light a body up. One hue each, taken to the hot end for
  // the light and to the calm end for the ground it falls on.
  const orangeHue = vividColour(orange, tuning.chroma);
  const blueHue = vividColour(blue, tuning.chroma);
  return {
    surface,
    ink,
    grid: resolve(palette.gridLine),
    orange,
    green,
    blue,
    // The same three, fit to be read as words and marks on this theme's surface.
    stateInk: {
      orange: readableColour(orange, ink, light),
      green: readableColour(green, ink, light),
      blue: readableColour(blue, ink, light),
    },
    // The light a blocked or unread body gives, and the ground it gives it over.
    stateGlow: {
      orange: stateGlow(orangeHue, light, tuning),
      blue: stateGlow(blueHue, light, tuning),
    },
    stateGround: {
      orange: stateGround(orangeHue, light, tuning),
      blue: stateGround(blueHue, light, tuning),
    },
    // agent-bubble.css's pre-blurred layers: black on light, white on dark.
    shadow: light ? [0, 0, 0, 0.18] : [1, 1, 1, 0.12],
    shadowPeak: light ? [0, 0, 0, 0.34] : [1, 1, 1, 0.3],
  };
}
