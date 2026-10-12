import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibefield/puppeteer-core';
import {
  captureKimiContinuationState,
  normalizeKimiNativeInvocation,
  restoreKimiContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'kimi',
  cwd: resolve('/repo'),
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
    const home = resolve('/tmp/kimi-imposter');
    expect(
      normalizeKimiNativeInvocation(
        invocation([], { implementation: { kind: 'imposter', executable: resolve('/opt/ai'), stateRoot: home } }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: resolve('/opt/ai'),
        kimiHome: home,
        env: { AI_PERSONA: 'kimi', KIMI_CODE_HOME: home, PUPPETEER_IMPOSTER_HOME: home },
      },
    });
    const state = captureKimiContinuationState({ kimiHome: '../kimi-home' }, resolve('/repo'), {});
    expect(restoreKimiContinuationState(state)).toEqual({ kimiHome: resolve('/kimi-home') });
    const imposterState = captureKimiContinuationState(
      {
        kimiHome: home,
        env: { AI_PERSONA: 'kimi', KIMI_CODE_HOME: home, PUPPETEER_IMPOSTER_HOME: home },
      },
      resolve('/repo'),
      {},
    );
    expect(restoreKimiContinuationState(imposterState, { imposterExecutable: resolve('/opt/ai') })).toEqual({
      executable: resolve('/opt/ai'),
      kimiHome: home,
      env: { AI_PERSONA: 'kimi', KIMI_CODE_HOME: home, PUPPETEER_IMPOSTER_HOME: home },
    });
    expect(() =>
      restoreKimiContinuationState(JSON.stringify({ version: 2, home: resolve('/kimi-home'), extra: true })),
    ).toThrow('invalid Kimi continuation state');
  });
});
