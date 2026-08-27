import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibecook/puppeteer-core';
import {
  captureHermesContinuationState,
  normalizeHermesNativeInvocation,
  restoreHermesContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'hermes',
  cwd: '/repo',
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
      options: { yolo: true, hermesHome: '/hermes-home' },
    });
    const state = captureHermesContinuationState('../hermes-home', undefined, '/repo', {});
    expect(restoreHermesContinuationState(state)).toEqual({ hermesHome: '/hermes-home' });
    expect(() =>
      restoreHermesContinuationState(JSON.stringify({ version: 1, home: '/hermes-home', extra: true })),
    ).toThrow('invalid Hermes continuation state');
  });

  it('rejects unadvertised imposter and native continuation picker semantics', () => {
    expect(
      normalizeHermesNativeInvocation(invocation([], { implementation: { kind: 'imposter', executable: '/opt/ai' } }))
        .status,
    ).toBe('rejected');
    expect(normalizeHermesNativeInvocation(invocation(['--continue'])).status).toBe('rejected');
  });
});
