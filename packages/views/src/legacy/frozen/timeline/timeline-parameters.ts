// FROZEN (MV-6): the timeline's tunables as it shipped before the timeline moved onto the SDK, runtime only, kept only
// as the "before" that `legacy/timeline-parity.test.tsx` renders beside the ported view over the same model. Only its
// imports changed (it moved folders). Never edit it to match the port; MV-8 deletes it with the shim.

import type { MonitorParameterGroup } from '../../../monitor/parameters.js';

// The timeline's tunables: few on purpose. The wake's widths, the colours and
// the motion are DESIGN §8's and are not offered; what is left is how strongly
// the wakes glow and how tall a lane may grow when there is room.

export interface TimelineParameters {
  /** The glow under each wake, as a multiple of DESIGN §8's (5px at 24% light · 6px at 62% dark). */
  glow: number;
  /** The tallest an agent's lane grows, px (DESIGN §8: 24–36). */
  laneMax: number;
}

export const DEFAULT_TIMELINE_PARAMETERS: Readonly<TimelineParameters> = {
  glow: 1,
  laneMax: 36,
};

export const TIMELINE_PARAMETER_GROUPS: readonly MonitorParameterGroup[] = [
  {
    title: 'WAKES',
    controls: [
      { key: 'glow', label: 'Glow', min: 0, max: 2, step: 0.05, defaultValue: 1 },
      { key: 'laneMax', label: 'Lane height', min: 24, max: 48, step: 1, defaultValue: 36 },
    ],
  },
];

const definitions = TIMELINE_PARAMETER_GROUPS.flatMap((group) => group.controls);

export function normalizeTimelineParameters(value: unknown): TimelineParameters {
  const source =
    value && typeof value === 'object' ? (value as Partial<Record<keyof TimelineParameters, unknown>>) : {};
  const normalized = { ...DEFAULT_TIMELINE_PARAMETERS };
  for (const definition of definitions) {
    const key = definition.key as keyof TimelineParameters;
    const candidate = source[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    normalized[key] = Math.max(definition.min, Math.min(definition.max, candidate));
  }
  return normalized;
}
