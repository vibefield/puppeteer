import type { MonitorParameterGroup } from '@vibecook/puppeteer-views';

/**
 * Stage-level tunables — the monitor's share of the window, which belongs to no
 * single view. Ported from vibe-field's monitor/stage-parameters.ts.
 *
 * Splitting these out is what lets a view's own controls come and go with it.
 * The CRT group is part of the reference's exact visual signature (DESIGN.md
 * §1.1). Height matters more than it looks: the rain spells each agent's
 * project, branch, model and context down its column and needs enough rows to
 * finish a cycle; the swarm needs room for a field of 60px working bodies not
 * to be wall-to-wall. The default splits the window roughly a third/two-thirds.
 *
 * The terminal safe area is the deck's, not a view's: the inset, per side,
 * between a pane's edge and the terminal grid inside it (record §07). The
 * defaults are the frame's bands as revised 2026-09-12: the sides closed, a
 * 24px band above for the badge and the readout, 30px below for the meter and
 * its figure. The deck stylesheet carries the same numbers as its fallbacks;
 * Ghosttea keeps a 2px origin of its own inside whatever inset is set.
 */
export const STAGE_PARAMETER_GROUPS: readonly MonitorParameterGroup[] = [
  {
    title: 'STAGE',
    controls: [{ key: 'stageHeight', label: 'Monitor height', min: 20, max: 80, step: 1, defaultValue: 35 }],
  },
  {
    title: 'TERMINAL SAFE AREA',
    controls: [
      { key: 'safeAreaLeft', label: 'Left', min: 0, max: 120, step: 1, defaultValue: 0 },
      { key: 'safeAreaTop', label: 'Top', min: 0, max: 120, step: 1, defaultValue: 24 },
      { key: 'safeAreaRight', label: 'Right', min: 0, max: 120, step: 1, defaultValue: 0 },
      { key: 'safeAreaBottom', label: 'Bottom', min: 0, max: 120, step: 1, defaultValue: 30 },
    ],
  },
  {
    title: 'CRT OVERLAYS',
    controls: [
      { key: 'scanlineDensity', label: 'Line density', min: 2, max: 16, step: 1, defaultValue: 2 },
      { key: 'scanlineOpacity', label: 'Line opacity', min: 0, max: 1, step: 0.05, defaultValue: 0.4 },
      { key: 'vignetteOpacity', label: 'Vignette', min: 0, max: 1, step: 0.05, defaultValue: 1 },
    ],
  },
];

export const STAGE_HEIGHT_KEY = 'stageHeight';
export const SAFE_AREA_LEFT_KEY = 'safeAreaLeft';
export const SAFE_AREA_TOP_KEY = 'safeAreaTop';
export const SAFE_AREA_RIGHT_KEY = 'safeAreaRight';
export const SAFE_AREA_BOTTOM_KEY = 'safeAreaBottom';
export const SCANLINE_DENSITY_KEY = 'scanlineDensity';
export const SCANLINE_OPACITY_KEY = 'scanlineOpacity';
export const VIGNETTE_OPACITY_KEY = 'vignetteOpacity';
