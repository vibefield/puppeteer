import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { AgentHost, AgentNativeInvocation, AgentNativeInvocationResolution } from '@vibecook/puppeteer-core';
import { createAgentRuntime } from './runtime.js';
import type { AgentProvider } from './types.js';

const host = { spawnTerminal: vi.fn(), automateTerminal: vi.fn() } as AgentHost;
/** A directory that exists: an accepted invocation's preparation gets as far as the provider. */
const cwd = tmpdir();

const invocation = (overrides: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'example',
  cwd,
  argv: [],
  environment: { EXAMPLE_HOME: '/profiles/example' },
  implementation: { kind: 'native' },
  ...overrides,
});

/**
 * One provider whose grammar is `normalize` and whose preparation throws if it
 * is ever reached: a door that must not prepare fails loudly if it does, and a
 * run it made would show on the monitor.
 */
function runtimeWith(normalize: (invocation: AgentNativeInvocation) => AgentNativeInvocationResolution) {
  const normalizeInvocation = vi.fn(normalize);
  const prepareSession = vi.fn(async () => {
    throw new Error('this door must never prepare');
  });
  const onError = vi.fn();
  const runtime = createAgentRuntime({
    host,
    defaultCwd: cwd,
    onError,
    providers: [
      {
        descriptor: { id: 'example', label: 'Example' },
        createSession: vi.fn(),
        prepareSession,
        launch: {
          provider: {
            id: 'example',
            label: 'Example',
            resume: true,
            nativeInvocation: {
              commands: [{ name: 'example', executable: '/opt/example' }],
              environmentVariables: ['EXAMPLE_HOME'],
              imposter: { state: 'none' },
              classifies: true,
            },
          },
          normalizeInvocation,
          continuation: { capture: () => undefined, restore: () => undefined },
        },
      } satisfies AgentProvider,
    ],
  });
  const monitored: string[] = [];
  runtime.onMonitorState((state) => monitored.push(`${state.runtimeRunId}:${state.status}`));
  return { runtime, normalizeInvocation, prepareSession, onError, monitored };
}

describe('what an invocation is — classifyInvocation, and prepareInvocation before it prepares', () => {
  it("answers the adapter's class and never its options", async () => {
    const accepted = runtimeWith(() => ({ status: 'accepted', resume: 'native-1', options: { secret: 'x' } }));
    expect(accepted.runtime.classifyInvocation(invocation())).toEqual({ status: 'accepted' });
    expect(accepted.normalizeInvocation).toHaveBeenCalledWith(invocation());

    for (const kind of ['utility', 'one-shot', 'elsewhere'] as const) {
      const { runtime } = runtimeWith(() => ({ status: 'passthrough', kind, reason: `a ${kind}` }));
      expect(runtime.classifyInvocation(invocation({ argv: ['--version'] }))).toEqual({
        status: 'passthrough',
        kind,
        reason: `a ${kind}`,
      });
    }

    const named = runtimeWith(() => ({ status: 'rejected', reason: 'cannot carry it', argument: '--bare' }));
    expect(named.runtime.classifyInvocation(invocation({ argv: ['--bare'] }))).toEqual({
      status: 'rejected',
      reason: 'cannot carry it',
      argument: '--bare',
    });
    const unnamed = runtimeWith(() => ({ status: 'rejected', reason: 'cannot carry it' }));
    expect(unnamed.runtime.classifyInvocation(invocation({ argv: ['--bare'] }))).toEqual({
      status: 'rejected',
      reason: 'cannot carry it',
    });
  });

  it("answers unsupported for every failure that is not the adapter's word", async () => {
    const { runtime, normalizeInvocation, onError } = runtimeWith(() => ({ status: 'accepted' }));
    expect(runtime.classifyInvocation(invocation({ providerId: 'missing' }))).toEqual({
      status: 'unsupported',
      code: 'NATIVE_INVOCATION_UNSUPPORTED',
      reason: 'agent provider does not support native terminal invocation: missing',
    });
    for (const outside of [
      invocation({ cwd: '' }),
      invocation({ environment: { SECRET: 'no' } }),
      invocation({ implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: '/state' } }),
    ]) {
      expect(runtime.classifyInvocation(outside)).toMatchObject({
        status: 'unsupported',
        code: 'INVALID_NATIVE_INVOCATION',
      });
    }
    // None of those reached the adapter.
    expect(normalizeInvocation).not.toHaveBeenCalled();

    const throwing = runtimeWith(() => {
      throw new Error('grammar bug');
    });
    expect(throwing.runtime.classifyInvocation(invocation())).toEqual({
      status: 'unsupported',
      code: 'INVALID_NATIVE_INVOCATION',
      reason: 'native invocation normalization failed for example',
    });
    expect(throwing.onError).toHaveBeenCalledWith(new Error('grammar bug'));
    expect(onError).not.toHaveBeenCalled();

    // A kind no host switches on is the adapter's bug, not a fourth kind.
    const unknownKind = runtimeWith(() => ({ status: 'passthrough', kind: 'session' as never, reason: 'x' }));
    expect(unknownKind.runtime.classifyInvocation(invocation())).toMatchObject({
      status: 'unsupported',
      code: 'INVALID_NATIVE_INVOCATION',
    });
  });

  it('classifies without ever preparing: no run, no preparation, whatever the class', async () => {
    for (const resolution of [
      { status: 'accepted' },
      { status: 'passthrough', kind: 'utility', reason: 'not a session' },
      { status: 'rejected', reason: 'cannot carry it', argument: '--bare' },
    ] as const) {
      const { runtime, prepareSession, monitored } = runtimeWith(() => resolution);
      runtime.classifyInvocation(invocation());
      // Anything the door set in motion has finished once the runtime is gone.
      await runtime.dispose();
      expect(prepareSession, resolution.status).not.toHaveBeenCalled();
      expect(monitored, resolution.status).toEqual([]);
    }
  });

  it('prepares nothing for a passthrough or a rejection, and says which it was', async () => {
    const passthrough = runtimeWith(() => ({ status: 'passthrough', kind: 'one-shot', reason: 'a print run' }));
    await expect(passthrough.runtime.prepareInvocation(invocation({ argv: ['-p', 'hi'] }))).resolves.toEqual({
      error: { code: 'NATIVE_INVOCATION_PASSTHROUGH', message: 'a print run', passthrough: 'one-shot' },
    });

    const rejected = runtimeWith(() => ({ status: 'rejected', reason: 'cannot carry it', argument: '--bare' }));
    await expect(rejected.runtime.prepareInvocation(invocation({ argv: ['--bare'] }))).resolves.toEqual({
      error: { code: 'INVALID_NATIVE_INVOCATION', message: 'cannot carry it', argument: '--bare' },
    });

    for (const { runtime, prepareSession, monitored } of [passthrough, rejected]) {
      await runtime.dispose();
      expect(prepareSession).not.toHaveBeenCalled();
      expect(monitored).toEqual([]);
    }
  });

  it('prepares an accepted invocation: the control that a run, when one is made, is seen', async () => {
    const { runtime, prepareSession, monitored } = runtimeWith(() => ({ status: 'accepted' }));
    const failed = await runtime.prepareInvocation(invocation());
    await runtime.dispose();
    // The provider's preparation throws by design: the run was made, and failed there.
    expect(failed).toMatchObject({ error: { code: 'AGENT_SESSION_CREATE_FAILED' } });
    expect(prepareSession).toHaveBeenCalledTimes(1);
    expect(monitored.length).toBeGreaterThan(0);
  });
});
