import type { MonitorParameterGroup } from '../../monitor/parameters.js';

export interface SwarmParameters {
  gravityPull: number;
  restitution: number;
  frictionAir: number;
  /** The body's fill alpha. vibe-field composites the reference's status bodies
   * at 72% so they stay legible glass over whatever is behind the stage. */
  bubbleFillOpacity: number;
  /** The blocked body's light: how far it reaches (px), how bright, and how
   * much it breathes (0 is the steady lamp). */
  glowReach: number;
  glowStrength: number;
  glowBreath: number;
  radiusIdle: number;
  radiusWorking: number;
  /** The working body with the most tokens among the working sessions; the least keeps `radiusWorking`. */
  radiusWorkingMax: number;
  radiusBlocked: number;
}

export type SwarmParameterKey = keyof SwarmParameters;

export const DEFAULT_SWARM_PARAMETERS: Readonly<SwarmParameters> = {
  gravityPull: 0.0002,
  restitution: 0,
  frictionAir: 0.2,
  bubbleFillOpacity: 0.72,
  glowReach: 34,
  glowStrength: 0.8,
  glowBreath: 0,
  radiusIdle: 50,
  radiusWorking: 60,
  radiusWorkingMax: 80,
  // Blocked is held at the idle size: the light says it.
  radiusBlocked: 50,
};

export const SWARM_PARAMETER_GROUPS: readonly MonitorParameterGroup[] = [
  {
    title: 'ENGINE VARIABLES',
    controls: [
      { key: 'gravityPull', label: 'Center gravity', min: 0, max: 0.005, step: 0.0001, defaultValue: 0.0002 },
      { key: 'restitution', label: 'Bounciness', min: 0, max: 1, step: 0.1, defaultValue: 0 },
      { key: 'frictionAir', label: 'Air friction', min: 0, max: 0.2, step: 0.01, defaultValue: 0.2 },
    ],
  },
  {
    title: 'PRESENTATION',
    controls: [
      { key: 'bubbleFillOpacity', label: 'Bubble fill opacity', min: 0, max: 1, step: 0.01, defaultValue: 0.72 },
      { key: 'glowReach', label: 'Pane light reach', min: 8, max: 90, step: 1, defaultValue: 34 },
      { key: 'glowStrength', label: 'Pane light strength', min: 0, max: 1.5, step: 0.05, defaultValue: 0.8 },
      { key: 'glowBreath', label: 'Pane light breath', min: 0, max: 1, step: 0.05, defaultValue: 0 },
    ],
  },
  {
    title: 'AGENT SIZES',
    controls: [
      { key: 'radiusIdle', label: 'Idle size', min: 20, max: 80, step: 1, defaultValue: 50 },
      { key: 'radiusWorking', label: 'Working size', min: 40, max: 120, step: 1, defaultValue: 60 },
      { key: 'radiusWorkingMax', label: 'Working size, largest', min: 40, max: 160, step: 1, defaultValue: 80 },
      { key: 'radiusBlocked', label: 'Blocked size', min: 20, max: 160, step: 1, defaultValue: 50 },
    ],
  },
];

const definitions = SWARM_PARAMETER_GROUPS.flatMap((group) => group.controls);

/** The view's own narrowing of the shell's flat bag back into typed physics inputs. */
export function normalizeSwarmParameters(value: unknown): SwarmParameters {
  const source = value && typeof value === 'object' ? (value as Partial<Record<SwarmParameterKey, unknown>>) : {};
  const normalized = { ...DEFAULT_SWARM_PARAMETERS };
  for (const definition of definitions) {
    const key = definition.key as SwarmParameterKey;
    const candidate = source[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    normalized[key] = Math.max(definition.min, Math.min(definition.max, candidate));
  }
  return normalized;
}

export function radiusForStatus(
  parameters: Pick<SwarmParameters, 'radiusIdle' | 'radiusWorking' | 'radiusBlocked'>,
  status: 'idle' | 'working' | 'blocked',
): number {
  switch (status) {
    case 'idle':
      return parameters.radiusIdle;
    case 'working':
      return parameters.radiusWorking;
    case 'blocked':
      return parameters.radiusBlocked;
  }
}
