import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentNativeInvocation } from '@vibefield/puppeteer-core';
import {
  captureGrokContinuationState,
  normalizeGrokNativeInvocation,
  restoreGrokContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'grok',
  cwd: resolve('/repo'),
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

const sessionId = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';
/** Composes no helper environment, so its helpers inherit this process's own. */
const inheritingHost = {};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Grok native invocation normalization', () => {
  it('normalizes latest/exact resume and supported safety intent', () => {
    expect(normalizeGrokNativeInvocation(invocation(['--continue']))).toEqual({
      status: 'accepted',
      options: { resumeLatest: true },
    });
    expect(
      normalizeGrokNativeInvocation(invocation(['--resume', sessionId, '--model', 'fast', '--sandbox', 'strict'])),
    ).toEqual({ status: 'accepted', resume: sessionId, options: { model: 'fast', sandbox: 'strict' } });
  });

  it('resumes by id alone: a title is refused with the reason Codex gives, and a bare -r stays the latest', () => {
    const refused = {
      status: 'rejected',
      reason: 'a managed session resumes a session by its id, not by its name, yet',
      argument: 'fix-login-bug',
    };
    expect(normalizeGrokNativeInvocation(invocation(['-r', 'fix-login-bug']))).toEqual(refused);
    expect(normalizeGrokNativeInvocation(invocation(['--resume', 'fix-login-bug']))).toEqual(refused);
    expect(normalizeGrokNativeInvocation(invocation(['--resume=fix-login-bug']))).toEqual(refused);
    expect(normalizeGrokNativeInvocation(invocation(['-r', sessionId]))).toEqual({
      status: 'accepted',
      resume: sessionId,
    });
    expect(normalizeGrokNativeInvocation(invocation(['-r']))).toEqual({
      status: 'accepted',
      options: { resumeLatest: true },
    });
  });

  it('owns the leader-wide environment and continuation state', () => {
    vi.stubEnv('GROK_HOME', '');
    const imposterRoot = resolve('/tmp/grok-imposter');
    expect(
      normalizeGrokNativeInvocation(
        invocation([], {
          environment: { GROK_HOME: '../grok-home' },
          implementation: { kind: 'imposter', executable: resolve('/opt/ai'), stateRoot: imposterRoot },
        }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: resolve('/opt/ai'),
        appServerEnv: {
          GROK_HOME: imposterRoot,
          AI_PERSONA: 'grok',
          PUPPETEER_IMPOSTER_HOME: imposterRoot,
        },
      },
    });
    expect(captureGrokContinuationState(undefined, resolve('/repo'), inheritingHost)).toBeUndefined();
    const state = captureGrokContinuationState(
      { appServerEnv: { GROK_HOME: '../grok-home' } },
      resolve('/repo'),
      inheritingHost,
    );
    expect(restoreGrokContinuationState(state)).toEqual({ appServerEnv: { GROK_HOME: resolve('/grok-home') } });
    const imposterState = captureGrokContinuationState(
      {
        appServerEnv: {
          AI_PERSONA: 'grok',
          GROK_HOME: imposterRoot,
          PUPPETEER_IMPOSTER_HOME: imposterRoot,
        },
      },
      resolve('/repo'),
      inheritingHost,
    );
    expect(restoreGrokContinuationState(imposterState, { imposterExecutable: resolve('/opt/ai') })).toEqual({
      executable: resolve('/opt/ai'),
      appServerEnv: {
        AI_PERSONA: 'grok',
        GROK_HOME: imposterRoot,
        PUPPETEER_IMPOSTER_HOME: imposterRoot,
      },
    });
    expect(() =>
      restoreGrokContinuationState(JSON.stringify({ version: 2, home: resolve('/grok-home'), extra: true })),
    ).toThrow('invalid Grok continuation state');
  });
});
