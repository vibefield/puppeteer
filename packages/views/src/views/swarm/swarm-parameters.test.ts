import { describe, expect, it } from 'vitest';
import { monitorParameterDefaults } from '../../monitor/parameters.js';
import {
  DEFAULT_SWARM_PARAMETERS,
  SWARM_PARAMETER_GROUPS,
  normalizeSwarmParameters,
  radiusForStatus,
} from './swarm-parameters.js';

describe('swarm parameters', () => {
  it('matches the decided defaults', () => {
    expect(DEFAULT_SWARM_PARAMETERS).toEqual({
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
      radiusBlocked: 50,
    });
  });

  it('declares the same defaults to the shell that it applies itself', () => {
    expect(monitorParameterDefaults(SWARM_PARAMETER_GROUPS)).toEqual({ ...DEFAULT_SWARM_PARAMETERS });
  });

  it('restores finite values and clamps them to the tweak panel ranges', () => {
    expect(
      normalizeSwarmParameters({ gravityPull: 2, restitution: -1, radiusWorking: 91, radiusBlocked: NaN }),
    ).toMatchObject({ gravityPull: 0.005, restitution: 0, radiusWorking: 91, radiusBlocked: 50 });
  });

  it('maps every live status to its configured radius', () => {
    expect(radiusForStatus(DEFAULT_SWARM_PARAMETERS, 'idle')).toBe(50);
    expect(radiusForStatus(DEFAULT_SWARM_PARAMETERS, 'working')).toBe(60);
    expect(radiusForStatus(DEFAULT_SWARM_PARAMETERS, 'blocked')).toBe(50);
  });
});
