import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibecook/puppeteer-core';
import {
  capturePiContinuationState,
  normalizePiNativeInvocation,
  restorePiContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'pi',
  cwd: '/repo',
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

describe('Pi native invocation normalization', () => {
  it('accepts the documented session selector and rejects the interactive picker as managed resume', () => {
    expect(normalizePiNativeInvocation(invocation(['--session=01abcdef', '--thinking=high']))).toEqual({
      status: 'accepted',
      resume: '01abcdef',
      options: { thinking: 'high' },
    });
    expect(normalizePiNativeInvocation(invocation(['-r'])).status).toBe('rejected');
    expect(normalizePiNativeInvocation(invocation(['--session', '../escape'])).status).toBe('rejected');
    expect(
      normalizePiNativeInvocation(
        invocation(['--session-dir', './explicit'], {
          environment: { PI_CODING_AGENT_SESSION_DIR: './environment' },
        }),
      ),
    ).toEqual({ status: 'accepted', options: { sessionDir: '/repo/explicit' } });
  });

  it('owns and restores an isolated imposter state root', () => {
    const root = '/tmp/pi-imposter';
    const normalized = normalizePiNativeInvocation(
      invocation([], { implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: root } }),
    );
    expect(normalized).toEqual({
      status: 'accepted',
      options: {
        executable: '/opt/ai',
        piAgentDir: root,
        sessionDir: '/tmp/pi-imposter/sessions',
        env: {
          AI_PERSONA: 'pi',
          PI_CODING_AGENT_DIR: root,
          PI_CODING_AGENT_SESSION_DIR: '/tmp/pi-imposter/sessions',
          PUPPETEER_IMPOSTER_HOME: root,
        },
      },
    });
    if (normalized.status !== 'accepted' || !normalized.options) throw new Error('expected accepted Pi options');
    const state = capturePiContinuationState(normalized.options, '/repo');
    expect(restorePiContinuationState(state, { imposterExecutable: '/opt/ai' })).toEqual(normalized.options);
    expect(() => restorePiContinuationState('{"version":1,"sessionDir":"/tmp","extra":true}')).toThrow(
      'invalid Pi continuation state',
    );
  });
});
