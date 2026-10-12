import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibefield/puppeteer-core';
import {
  captureHermesContinuationState,
  normalizeHermesNativeInvocation,
  restoreHermesContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'hermes',
  cwd: resolve('/repo'),
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

describe('Hermes native invocation normalization', () => {
  it('normalizes exact resume, yolo, and the owned home', () => {
    expect(
      normalizeHermesNativeInvocation(
        invocation(['--resume', 'session-1', '--yolo'], { environment: { HERMES_HOME: '../hermes-home' } }),
      ),
    ).toEqual({
      status: 'accepted',
      resume: 'session-1',
      options: { yolo: true, hermesHome: resolve('/hermes-home') },
    });
    const state = captureHermesContinuationState('../hermes-home', undefined, resolve('/repo'), {});
    expect(restoreHermesContinuationState(state)).toEqual({ hermesHome: resolve('/hermes-home') });
    expect(() =>
      restoreHermesContinuationState(JSON.stringify({ version: 1, home: resolve('/hermes-home'), extra: true })),
    ).toThrow('invalid Hermes continuation state');
  });

  it('rejects unadvertised imposter and native continuation picker semantics', () => {
    expect(
      normalizeHermesNativeInvocation(
        invocation([], { implementation: { kind: 'imposter', executable: resolve('/opt/ai') } }),
      ).status,
    ).toBe('rejected');
    expect(normalizeHermesNativeInvocation(invocation(['--continue'])).status).toBe('rejected');
  });
});
