import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibecook/puppeteer-core';
import {
  captureOpenCodeContinuationState,
  normalizeOpenCodeNativeInvocation,
  restoreOpenCodeContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'opencode',
  cwd: '/repo',
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

describe('OpenCode native invocation normalization', () => {
  it('normalizes exact session selection and rejects unsupported argv', () => {
    expect(normalizeOpenCodeNativeInvocation(invocation(['--session', 'ses_a11a5ed0']))).toEqual({
      status: 'accepted',
      resume: 'ses_a11a5ed0',
    });
    expect(normalizeOpenCodeNativeInvocation(invocation(['--continue'])).status).toBe('rejected');
  });

  it('owns the private-backend imposter store', () => {
    const home = '/tmp/opencode-imposter';
    expect(
      normalizeOpenCodeNativeInvocation(
        invocation([], { implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: home } }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: '/opt/ai',
        env: { AI_PERSONA: 'opencode', PUPPETEER_IMPOSTER_HOME: home },
      },
    });
    const state = captureOpenCodeContinuationState(
      { env: { AI_PERSONA: 'opencode', PUPPETEER_IMPOSTER_HOME: home } },
      '/repo',
    );
    expect(restoreOpenCodeContinuationState(state, { imposterExecutable: '/opt/ai' })).toEqual({
      executable: '/opt/ai',
      env: { AI_PERSONA: 'opencode', PUPPETEER_IMPOSTER_HOME: home },
    });
    expect(() =>
      restoreOpenCodeContinuationState(JSON.stringify({ version: 1, imposterRoot: home, extra: true }), {
        imposterExecutable: '/opt/ai',
      }),
    ).toThrow('invalid OpenCode continuation state');
  });
});
