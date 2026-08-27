import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibecook/puppeteer-core';
import {
  captureCodexContinuationState,
  normalizeCodexNativeInvocation,
  restoreCodexContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'codex',
  cwd: '/repo',
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

describe('Codex native invocation normalization', () => {
  it('distinguishes an exact thread id from the native resume selection flow', () => {
    const id = '64a61b19-f4d8-4f96-ba56-07024b470813';
    expect(normalizeCodexNativeInvocation(invocation(['resume', id]))).toEqual({ status: 'accepted', resume: id });
    expect(normalizeCodexNativeInvocation(invocation(['resume', '--last']))).toEqual({
      status: 'accepted',
      options: { resumeInvocation: ['resume', '--last'] },
    });
  });

  it('owns app-server environment, imposter selection, and continuation state', () => {
    const imposterRoot = '/tmp/codex-imposter';
    expect(
      normalizeCodexNativeInvocation(
        invocation([], {
          environment: { CODEX_HOME: '../codex-home' },
          implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: imposterRoot },
        }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: '/opt/ai',
        env: { CODEX_HOME: '/codex-home', AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot },
        appServerEnv: {
          CODEX_HOME: '/codex-home',
          AI_PERSONA: 'codex',
          PUPPETEER_IMPOSTER_HOME: imposterRoot,
        },
      },
    });
    const state = captureCodexContinuationState({ appServerEnv: { CODEX_HOME: '../codex-home' } }, '/repo', {});
    expect(restoreCodexContinuationState(state)).toEqual({
      env: { CODEX_HOME: '/codex-home' },
      appServerEnv: { CODEX_HOME: '/codex-home' },
    });
    const imposterState = captureCodexContinuationState(
      { appServerEnv: { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot } },
      '/repo',
      {},
    );
    expect(restoreCodexContinuationState(imposterState, { imposterExecutable: '/opt/ai' })).toEqual({
      executable: '/opt/ai',
      env: { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot },
      appServerEnv: { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot },
    });
    expect(() =>
      restoreCodexContinuationState(JSON.stringify({ version: 2, home: '/codex-home', extra: true })),
    ).toThrow('invalid Codex continuation state');
  });

  it('rejects caller-owned remote transport arguments', () => {
    expect(normalizeCodexNativeInvocation(invocation(['resume', '--remote', 'ws://outside'])).status).toBe('rejected');
    expect(normalizeCodexNativeInvocation(invocation(['resume', '--last', 'unexpected-prompt'])).status).toBe(
      'rejected',
    );
  });
});
