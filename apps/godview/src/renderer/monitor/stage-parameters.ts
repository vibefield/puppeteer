import type { MonitorParameterGroup } from './parameters.js';

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
 */
export const STAGE_PARAMETER_GROUPS: readonly MonitorParameterGroup[] = [
  {
    title: 'STAGE',
    controls: [{ key: 'stageHeight', label: 'Monitor height', min: 20, max: 80, step: 1, defaultValue: 35 }],
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
export const SCANLINE_DENSITY_KEY = 'scanlineDensity';
export const SCANLINE_OPACITY_KEY = 'scanlineOpacity';
export const VIGNETTE_OPACITY_KEY = 'vignetteOpacity';
