import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibefield/puppeteer-core';
import {
  captureOpenCodeContinuationState,
  normalizeOpenCodeNativeInvocation,
  restoreOpenCodeContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'opencode',
  cwd: resolve('/repo'),
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
    const home = resolve('/tmp/opencode-imposter');
    expect(
      normalizeOpenCodeNativeInvocation(
        invocation([], { implementation: { kind: 'imposter', executable: resolve('/opt/ai'), stateRoot: home } }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: resolve('/opt/ai'),
        env: { AI_PERSONA: 'opencode', PUPPETEER_IMPOSTER_HOME: home },
      },
    });
    const state = captureOpenCodeContinuationState(
      { env: { AI_PERSONA: 'opencode', PUPPETEER_IMPOSTER_HOME: home } },
      resolve('/repo'),
    );
    expect(restoreOpenCodeContinuationState(state, { imposterExecutable: resolve('/opt/ai') })).toEqual({
      executable: resolve('/opt/ai'),
      env: { AI_PERSONA: 'opencode', PUPPETEER_IMPOSTER_HOME: home },
    });
    expect(() =>
      restoreOpenCodeContinuationState(JSON.stringify({ version: 1, imposterRoot: home, extra: true }), {
        imposterExecutable: resolve('/opt/ai'),
      }),
    ).toThrow('invalid OpenCode continuation state');
  });

  it('forwards the profile data root into the launch environment', () => {
    expect(
      normalizeOpenCodeNativeInvocation(
        invocation([], { environment: { XDG_DATA_HOME: resolve('/profiles/opencode/77c5b0ad/data') } }),
      ),
    ).toEqual({
      status: 'accepted',
      options: { env: { XDG_DATA_HOME: resolve('/profiles/opencode/77c5b0ad/data') } },
    });
  });

  it('resolves a relative data root against the launch directory', () => {
    expect(
      normalizeOpenCodeNativeInvocation(invocation([], { environment: { XDG_DATA_HOME: '../shared/data' } })),
    ).toEqual({ status: 'accepted', options: { env: { XDG_DATA_HOME: resolve('/shared/data') } } });
  });

  it('round-trips the data root through a continuation', () => {
    const state = captureOpenCodeContinuationState(
      { env: { XDG_DATA_HOME: resolve('/profiles/opencode/a/data') } },
      resolve('/repo'),
    );
    expect(JSON.parse(state!)).toEqual({ version: 2, dataHome: resolve('/profiles/opencode/a/data') });
    expect(restoreOpenCodeContinuationState(state)).toEqual({
      env: { XDG_DATA_HOME: resolve('/profiles/opencode/a/data') },
    });
  });

  it('round-trips a data root and an imposter root together', () => {
    const state = captureOpenCodeContinuationState(
      {
        env: {
          XDG_DATA_HOME: resolve('/profiles/opencode/a/data'),
          AI_PERSONA: 'opencode',
          PUPPETEER_IMPOSTER_HOME: resolve('/tmp/i'),
        },
      },
      resolve('/repo'),
    );
    expect(restoreOpenCodeContinuationState(state, { imposterExecutable: resolve('/opt/ai') })).toEqual({
      executable: resolve('/opt/ai'),
      env: {
        XDG_DATA_HOME: resolve('/profiles/opencode/a/data'),
        AI_PERSONA: 'opencode',
        PUPPETEER_IMPOSTER_HOME: resolve('/tmp/i'),
      },
    });
  });

  it('keeps decoding version 1 continuations written before profiles existed', () => {
    expect(
      restoreOpenCodeContinuationState(JSON.stringify({ version: 1, imposterRoot: resolve('/tmp/legacy') }), {
        imposterExecutable: resolve('/opt/ai'),
      }),
    ).toEqual({
      executable: resolve('/opt/ai'),
      env: { AI_PERSONA: 'opencode', PUPPETEER_IMPOSTER_HOME: resolve('/tmp/legacy') },
    });
  });

  it('captures nothing when the launch carries no adapter-owned environment', () => {
    expect(captureOpenCodeContinuationState({}, resolve('/repo'))).toBeUndefined();
    expect(captureOpenCodeContinuationState(undefined, resolve('/repo'))).toBeUndefined();
  });
});
