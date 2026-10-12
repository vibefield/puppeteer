import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibefield/puppeteer-core';
import {
  captureCopilotContinuationState,
  normalizeCopilotNativeInvocation,
  restoreCopilotContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'copilot',
  cwd: resolve('/repo'),
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

describe('Copilot native invocation normalization', () => {
  it('keeps resume distinct from fresh session identity', () => {
    expect(normalizeCopilotNativeInvocation(invocation(['--resume=session-1', '--allow-all']))).toEqual({
      status: 'accepted',
      resume: 'session-1',
      options: { allowAll: true },
    });
    expect(normalizeCopilotNativeInvocation(invocation(['--resume=session-1', '--name=named-session']))).toMatchObject({
      status: 'rejected',
      argument: '--name',
    });
    expect(normalizeCopilotNativeInvocation(invocation(['--session-id', 'fresh-session'])).status).toBe('rejected');
    expect(normalizeCopilotNativeInvocation(invocation(['--resume', '../escape'])).status).toBe('rejected');
  });

  it('owns and restores an isolated imposter state root', () => {
    const root = resolve('/tmp/copilot-imposter');
    const normalized = normalizeCopilotNativeInvocation(
      invocation([], { implementation: { kind: 'imposter', executable: resolve('/opt/ai'), stateRoot: root } }),
    );
    expect(normalized).toEqual({
      status: 'accepted',
      options: {
        executable: resolve('/opt/ai'),
        copilotHome: root,
        env: { AI_PERSONA: 'copilot', COPILOT_HOME: root, PUPPETEER_IMPOSTER_HOME: root },
      },
    });
    if (normalized.status !== 'accepted' || !normalized.options) throw new Error('expected accepted Copilot options');
    const state = captureCopilotContinuationState(normalized.options, resolve('/repo'));
    expect(restoreCopilotContinuationState(state, { imposterExecutable: resolve('/opt/ai') })).toEqual(
      normalized.options,
    );
    expect(() => restoreCopilotContinuationState('{"version":1,"home":"/tmp","extra":true}')).toThrow(
      'invalid Copilot continuation state',
    );
  });
});
