import type { MonitorPalette } from '@vibecook/puppeteer-view-sdk';
import {
  isLightTheme,
  readableColour,
  resolveCssColor,
  stateGround,
  vividColour,
  type Rgba,
} from '@vibecook/puppeteer-view-sdk/toolkit';

// The palette resolved to the numbers a 2D context wants, once per theme. The
// timeline's bodies are lit as the swarm lights them (DESIGN §8): the state
// lights are the toolkit's (`/toolkit` light.ts, M57), the rules the swarm burns
// its orange and blue by, at the swarm's default tuning — full chroma for the
// light, darkened toward the ink to be read as words on a light theme, and
// carried to this theme's paper for the ground a lit body sits on.

export type { Rgba };
/** A colour as a 2D context's `rgba()` (the toolkit's `rgbaCss`). */
export { rgbaCss as css } from '@vibecook/puppeteer-view-sdk/toolkit';

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

export function resolveTimelineInks(palette: MonitorPalette, context: Element | undefined): TimelineInks {
  const resolve = (value: string): Rgba => resolveCssColor(value, context);
  const ink = resolve(palette.swarm.ink);
  const light = isLightTheme(ink);
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
    orangeInk: readableColour(orange, ink, light),
    blueInk: readableColour(blue, ink, light),
    orangeGround: stateGround(vividColour(orange), light),
    blueGround: stateGround(vividColour(blue), light),
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
