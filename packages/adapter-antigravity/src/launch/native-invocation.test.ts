import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibefield/puppeteer-core';
import {
  captureAntigravityContinuationState,
  normalizeAntigravityNativeInvocation,
  restoreAntigravityContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'antigravity',
  cwd: '/repo',
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

describe('Antigravity native invocation normalization', () => {
  it('normalizes supported intent and rejects unsafe conversation ids', () => {
    expect(
      normalizeAntigravityNativeInvocation(
        invocation(['--conversation=conversation-1', '--model=gemini', '--mode=default', '--add-dir=../shared']),
      ),
    ).toEqual({
      status: 'accepted',
      resume: 'conversation-1',
      options: { model: 'gemini', mode: 'default', addDirs: ['/shared'] },
    });
    expect(normalizeAntigravityNativeInvocation(invocation(['--conversation', '../escape'])).status).toBe('rejected');
    expect(normalizeAntigravityNativeInvocation(invocation(['--effort', 'maximum'])).status).toBe('rejected');
    expect(normalizeAntigravityNativeInvocation(invocation(['--mode', 'autopilot'])).status).toBe('rejected');
  });

  it('owns and restores an isolated imposter state root', () => {
    const root = '/tmp/antigravity-imposter';
    const normalized = normalizeAntigravityNativeInvocation(
      invocation([], { implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: root } }),
    );
    expect(normalized).toEqual({
      status: 'accepted',
      options: {
        executable: '/opt/ai',
        dataRoot: root,
        env: {
          AI_PERSONA: 'antigravity',
          PUPPETEER_ANTIGRAVITY_DATA_ROOT: root,
          PUPPETEER_IMPOSTER_HOME: root,
        },
      },
    });
    if (normalized.status !== 'accepted' || !normalized.options)
      throw new Error('expected accepted Antigravity options');
    const state = captureAntigravityContinuationState(normalized.options, '/repo');
    expect(restoreAntigravityContinuationState(state, { imposterExecutable: '/opt/ai' })).toEqual(normalized.options);
    expect(() => restoreAntigravityContinuationState('{"version":1,"dataRoot":"/tmp","extra":true}')).toThrow(
      'invalid Antigravity continuation state',
    );
    expect(() =>
      restoreAntigravityContinuationState('{"version":1,"home":"/tmp/home","imposterRoot":"/tmp/imposter"}', {
        imposterExecutable: '/opt/ai',
      }),
    ).toThrow('invalid Antigravity continuation state');
  });
});
