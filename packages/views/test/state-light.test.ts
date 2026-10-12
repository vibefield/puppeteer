import { describe, expect, it } from 'vitest';
import type { MonitorPalette } from '@vibefield/puppeteer-view-sdk';
import { fixtureTheme } from '@vibefield/puppeteer-view-sdk/testing';
import { DEFAULT_STATE_LIGHT } from '@vibefield/puppeteer-view-sdk/toolkit';
import { DEFAULT_SWARM_PARAMETERS } from '../src/views/swarm/swarm-parameters.js';
import { resolveSwarmTheme } from '../src/views/swarm/swarm-theme.js';
import { resolveTimelineInks } from '../src/views/timeline/timeline-inks.js';

// THE TIMELINE LIGHTS ITS BODIES AS THE SWARM DOES (DESIGN §8). Both draw state from the toolkit's one light module
// since MV-8 (M57), the timeline at the swarm's default tuning. This reads the two views side by side, so it lives
// outside both folders (a view's folder imports only the SDK, MV-W1); it replaces the parity test that held the
// timeline's private copy of the math equal to the swarm's.

describe('the state light, across the two views that paint it', () => {
  it('the swarm’s default tuning is the toolkit’s, the one the timeline lights at', () => {
    expect({
      chroma: DEFAULT_SWARM_PARAMETERS.stateChroma,
      glowLift: DEFAULT_SWARM_PARAMETERS.stateGlowLift,
      groundLight: DEFAULT_SWARM_PARAMETERS.stateGroundLight,
      groundDark: DEFAULT_SWARM_PARAMETERS.stateGroundDark,
    }).toEqual(DEFAULT_STATE_LIGHT);
  });

  it('the timeline’s words and grounds for a blocked or unread body are the swarm’s, in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const tokens = fixtureTheme(scheme).tokens as MonitorPalette;
      const swarm = resolveSwarmTheme(tokens.swarm, undefined, DEFAULT_SWARM_PARAMETERS);
      const timeline = resolveTimelineInks(tokens, undefined);
      expect(timeline.dark).toBe(scheme === 'dark');
      expect({
        ink: timeline.ink,
        orange: timeline.orange,
        blue: timeline.blue,
        orangeInk: timeline.orangeInk,
        blueInk: timeline.blueInk,
        orangeGround: timeline.orangeGround,
        blueGround: timeline.blueGround,
      }).toEqual({
        ink: swarm.ink,
        orange: swarm.orange,
        blue: swarm.blue,
        orangeInk: swarm.stateInk.orange,
        blueInk: swarm.stateInk.blue,
        orangeGround: swarm.stateGround.orange,
        blueGround: swarm.stateGround.blue,
      });
    }
  });
});
