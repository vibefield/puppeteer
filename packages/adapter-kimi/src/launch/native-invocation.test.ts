import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibefield/puppeteer-core';
import {
  captureKimiContinuationState,
  normalizeKimiNativeInvocation,
  restoreKimiContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'kimi',
  cwd: '/repo',
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

describe('Kimi native invocation normalization', () => {
  it('normalizes session and supported native intent while rejecting unsafe ids', () => {
    expect(normalizeKimiNativeInvocation(invocation(['--session', 'session_a11a5ed0', '--yolo', '--plan']))).toEqual({
      status: 'accepted',
      resume: 'session_a11a5ed0',
      options: { permissionMode: 'yolo', plan: true },
    });
    expect(normalizeKimiNativeInvocation(invocation(['--session', '..'])).status).toBe('rejected');
  });

  it('requires and owns one isolated imposter store', () => {
    const home = '/tmp/kimi-imposter';
    expect(
      normalizeKimiNativeInvocation(
        invocation([], { implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: home } }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: '/opt/ai',
        kimiHome: home,
        env: { AI_PERSONA: 'kimi', KIMI_CODE_HOME: home, PUPPETEER_IMPOSTER_HOME: home },
      },
    });
    const state = captureKimiContinuationState({ kimiHome: '../kimi-home' }, '/repo', {});
    expect(restoreKimiContinuationState(state)).toEqual({ kimiHome: '/kimi-home' });
    const imposterState = captureKimiContinuationState(
      {
        kimiHome: home,
        env: { AI_PERSONA: 'kimi', KIMI_CODE_HOME: home, PUPPETEER_IMPOSTER_HOME: home },
      },
      '/repo',
      {},
    );
    expect(restoreKimiContinuationState(imposterState, { imposterExecutable: '/opt/ai' })).toEqual({
      executable: '/opt/ai',
      kimiHome: home,
      env: { AI_PERSONA: 'kimi', KIMI_CODE_HOME: home, PUPPETEER_IMPOSTER_HOME: home },
    });
    expect(() => restoreKimiContinuationState(JSON.stringify({ version: 2, home: '/kimi-home', extra: true }))).toThrow(
      'invalid Kimi continuation state',
    );
  });
});
