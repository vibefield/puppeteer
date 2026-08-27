import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibecook/puppeteer-core';
import {
  captureGrokContinuationState,
  normalizeGrokNativeInvocation,
  restoreGrokContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'grok',
  cwd: '/repo',
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

describe('Grok native invocation normalization', () => {
  it('normalizes latest/exact resume and supported safety intent', () => {
    expect(normalizeGrokNativeInvocation(invocation(['--continue']))).toEqual({
      status: 'accepted',
      options: { resumeLatest: true },
    });
    expect(
      normalizeGrokNativeInvocation(invocation(['--resume', 'session-1', '--model', 'fast', '--sandbox', 'strict'])),
    ).toEqual({ status: 'accepted', resume: 'session-1', options: { model: 'fast', sandbox: 'strict' } });
  });

  it('owns the leader-wide environment and continuation state', () => {
    const imposterRoot = '/tmp/grok-imposter';
    expect(
      normalizeGrokNativeInvocation(
        invocation([], {
          environment: { GROK_HOME: '../grok-home' },
          implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: imposterRoot },
        }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: '/opt/ai',
        appServerEnv: {
          GROK_HOME: imposterRoot,
          AI_PERSONA: 'grok',
          PUPPETEER_IMPOSTER_HOME: imposterRoot,
        },
      },
    });
    const state = captureGrokContinuationState({ appServerEnv: { GROK_HOME: '../grok-home' } }, '/repo', {});
    expect(restoreGrokContinuationState(state)).toEqual({ appServerEnv: { GROK_HOME: '/grok-home' } });
    const imposterState = captureGrokContinuationState(
      {
        appServerEnv: {
          AI_PERSONA: 'grok',
          GROK_HOME: imposterRoot,
          PUPPETEER_IMPOSTER_HOME: imposterRoot,
        },
      },
      '/repo',
      {},
    );
    expect(restoreGrokContinuationState(imposterState, { imposterExecutable: '/opt/ai' })).toEqual({
      executable: '/opt/ai',
      appServerEnv: {
        AI_PERSONA: 'grok',
        GROK_HOME: imposterRoot,
        PUPPETEER_IMPOSTER_HOME: imposterRoot,
      },
    });
    expect(() => restoreGrokContinuationState(JSON.stringify({ version: 2, home: '/grok-home', extra: true }))).toThrow(
      'invalid Grok continuation state',
    );
  });
});
