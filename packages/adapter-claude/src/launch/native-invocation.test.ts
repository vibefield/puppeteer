import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibecook/puppeteer-core';
import {
  captureClaudeContinuationState,
  normalizeClaudeNativeInvocation,
  restoreClaudeContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'claude',
  cwd: '/repo',
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

describe('Claude native invocation normalization', () => {
  it('normalizes explicit resume, picker resume, and supported launch intent', () => {
    const id = '64a61b19-f4d8-4f96-ba56-07024b470813';
    expect(normalizeClaudeNativeInvocation(invocation(['--resume', id]))).toEqual({ status: 'accepted', resume: id });
    expect(normalizeClaudeNativeInvocation(invocation(['--continue', '--model', 'sonnet']))).toEqual({
      status: 'accepted',
      options: { model: 'sonnet', resumeInvocation: ['--continue'] },
    });
    expect(
      normalizeClaudeNativeInvocation(
        invocation(['--setting-sources', 'project,local'], { environment: { CLAUDE_CONFIG_DIR: '../profile' } }),
      ),
    ).toEqual({
      status: 'accepted',
      options: { settingSources: ['project', 'local'], configDir: '/profile' },
    });
  });

  it('owns imposter environment and continuation state', () => {
    const imposterRoot = '/tmp/claude-imposter';
    expect(
      normalizeClaudeNativeInvocation(
        invocation([], { implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: imposterRoot } }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: '/opt/ai',
        env: { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: imposterRoot },
      },
    });
    const state = captureClaudeContinuationState({ configDir: '../profile' }, '/repo', {});
    expect(restoreClaudeContinuationState(state)).toEqual({ configDir: '/profile' });
    const imposterState = captureClaudeContinuationState(
      { env: { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: imposterRoot } },
      '/repo',
      {},
    );
    expect(restoreClaudeContinuationState(imposterState, { imposterExecutable: '/opt/ai' })).toEqual({
      executable: '/opt/ai',
      env: { AI_PERSONA: 'claude', PUPPETEER_IMPOSTER_HOME: imposterRoot },
    });
    expect(restoreClaudeContinuationState(JSON.stringify({ kind: 'claude', configDir: '/legacy' }))).toEqual({
      configDir: '/legacy',
    });
    expect(() =>
      restoreClaudeContinuationState(JSON.stringify({ version: 2, configDir: '/profile', extra: true })),
    ).toThrow('invalid Claude continuation state');
  });

  it('rejects unsupported or malformed native arguments', () => {
    expect(normalizeClaudeNativeInvocation(invocation(['--model'])).status).toBe('rejected');
    expect(normalizeClaudeNativeInvocation(invocation(['--setting-sources', 'managed'])).status).toBe('rejected');
  });
});
