import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { monitorParameterDefaults } from '@vibefield/puppeteer-views';
import {
  SAFE_AREA_BOTTOM_KEY,
  SAFE_AREA_LEFT_KEY,
  SAFE_AREA_RIGHT_KEY,
  SAFE_AREA_TOP_KEY,
  STAGE_PARAMETER_GROUPS,
} from './stage-parameters.js';

const SIDES = [
  ['top', SAFE_AREA_TOP_KEY],
  ['right', SAFE_AREA_RIGHT_KEY],
  ['bottom', SAFE_AREA_BOTTOM_KEY],
  ['left', SAFE_AREA_LEFT_KEY],
] as const;

describe('terminal safe area', () => {
  it('defaults to closed sides, a 24px band above and a 30px band below', () => {
    const defaults = monitorParameterDefaults(STAGE_PARAMETER_GROUPS);
    expect(SIDES.map(([, key]) => defaults[key])).toEqual([24, 0, 30, 0]);
  });

  it('keeps the same numbers as the deck stylesheet falls back to', () => {
    // The stylesheet must draw the decided frame on its own when no tuning has
    // been applied, so its fallbacks and the controls' defaults are one fact.
    // The frame is the views package's since PU-14; its stylesheet is read
    // through the package's own export, wherever the package resolves from.
    const css = readFileSync(
      createRequire(import.meta.url).resolve('@vibefield/puppeteer-views/styles/deck-frame.css'),
      'utf8',
    );
    const defaults = monitorParameterDefaults(STAGE_PARAMETER_GROUPS);
    for (const [side, key] of SIDES) {
      expect(css).toContain(`var(--vf-terminal-safe-${side}, ${defaults[key]}px)`);
    }
  });

  it('lets every side close to nothing and never go negative', () => {
    const group = STAGE_PARAMETER_GROUPS.find((candidate) => candidate.title === 'TERMINAL SAFE AREA');
    expect(group?.controls.map((control) => [control.min, control.step])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
  });
});
