import type { MonitorParameterGroup } from '@vibefield/puppeteer-view-sdk';
import { FRICTION_AIR_CEILING, PHYSICS_HZ_FLOOR } from './physics/world.js';

export interface SwarmParameters {
  gravityPull: number;
  restitution: number;
  frictionAir: number;
  /** How often the physics steps, in Hz — decoupled from paint (GT-D15.2).
   * The render loop interpolates between the last two solved states, so
   * this is a cost knob and not a smoothness knob. */
  physicsHz: number;
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

  // ── The light a blocked or unread body gives (2026-09-18) ──────────────
  /** How much more saturated a state colour is as LIGHT than as a label. 1 is the kit's token untouched. */
  stateChroma: number;
  /** A dark theme's ground: the fraction of the light's brightness it keeps. */
  stateGroundDark: number;
  /** A light theme's ground: how far the light is carried toward white. */
  stateGroundLight: number;
  /** A dark theme's glow: how far the light itself is carried toward white. */
  stateGlowLift: number;
  /** The glow's own strength where a wave crests. */
  stateGlowStrength: number;
  /** Where the glow begins, as a fraction of the radius. */
  stateGlowInner: number;
  /** Where it reaches full. Near the rim, so the ramp crosses most of the body. */
  stateGlowFull: number;
  /** Wave crests across the radius. */
  stateWaveCount: number;
  /** Crests passing a second. */
  stateWaveSpeed: number;
  /** How far a trough dims between crests; 0 is a steady glow. */
  stateWaveDepth: number;
}

export type SwarmParameterKey = keyof SwarmParameters;

export const DEFAULT_SWARM_PARAMETERS: Readonly<SwarmParameters> = {
  gravityPull: 0.0002,
  restitution: 0,
  frictionAir: 0.2,
  physicsHz: 30,
  bubbleFillOpacity: 0.72,
  glowReach: 34,
  glowStrength: 0.8,
  glowBreath: 0,
  radiusIdle: 50,
  radiusWorking: 60,
  radiusWorkingMax: 80,
  // Blocked is held at the idle size: the light says it.
  radiusBlocked: 50,
  stateChroma: 1.22,
  stateGroundDark: 0.5,
  stateGroundLight: 0.45,
  stateGlowLift: 0.55,
  stateGlowStrength: 0.2,
  stateGlowInner: 0.11,
  stateGlowFull: 0.9,
  stateWaveCount: 1.7,
  stateWaveSpeed: 1.75,
  stateWaveDepth: 0.72,
};

export const SWARM_PARAMETER_GROUPS: readonly MonitorParameterGroup[] = [
  {
    title: 'ENGINE VARIABLES',
    controls: [
      { key: 'gravityPull', label: 'Center gravity', min: 0, max: 0.005, step: 0.0001, defaultValue: 0.0002 },
      { key: 'restitution', label: 'Bounciness', min: 0, max: 1, step: 0.1, defaultValue: 0 },
      // The ceiling is a stability limit like the rate's floor, stated once
      // beside the physics that depends on it: matter's air friction goes
      // negative when the step passes `_baseDelta / frictionAir`.
      { key: 'frictionAir', label: 'Air friction', min: 0, max: FRICTION_AIR_CEILING, step: 0.01, defaultValue: 0.2 },
      { key: 'physicsHz', label: 'Physics rate (Hz)', min: PHYSICS_HZ_FLOOR, max: 120, step: 5, defaultValue: 30 },
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
    // The two states that light a body up. The ground and the glow are one hue
    // at two ends of its range, and the waves carry the glow outward through it.
    // Tuned 2026-09-19: a wide, quick, shallow sheen rather than a bright ring —
    // the glow is held at a fifth of its strength, which is what keeps it off the
    // copy now that its ramp reaches nearly to the centre.
    title: 'STATE GLOW',
    controls: [
      { key: 'stateChroma', label: 'Chroma', min: 1, max: 1.8, step: 0.02, defaultValue: 1.22 },
      { key: 'stateGroundDark', label: 'Ground, dark theme', min: 0.05, max: 0.8, step: 0.01, defaultValue: 0.5 },
      { key: 'stateGroundLight', label: 'Ground, light theme', min: 0, max: 0.85, step: 0.01, defaultValue: 0.45 },
      { key: 'stateGlowLift', label: 'Glow lift, dark theme', min: 0, max: 1, step: 0.05, defaultValue: 0.55 },
      { key: 'stateGlowStrength', label: 'Glow strength', min: 0, max: 1, step: 0.02, defaultValue: 0.2 },
      { key: 'stateGlowInner', label: 'Glow starts at', min: 0, max: 0.9, step: 0.01, defaultValue: 0.11 },
      { key: 'stateGlowFull', label: 'Glow full at', min: 0.1, max: 1, step: 0.01, defaultValue: 0.9 },
      { key: 'stateWaveCount', label: 'Waves across', min: 0, max: 6, step: 0.1, defaultValue: 1.7 },
      { key: 'stateWaveSpeed', label: 'Wave speed', min: 0, max: 2, step: 0.05, defaultValue: 1.75 },
      { key: 'stateWaveDepth', label: 'Wave depth', min: 0, max: 1, step: 0.02, defaultValue: 0.72 },
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
