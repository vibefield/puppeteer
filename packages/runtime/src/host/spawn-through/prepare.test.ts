import { describe, expect, it, vi } from 'vitest';
import type { AgentLaunchProvider } from '@vibecook/puppeteer-core';
import { prepareSpawnThroughLaunch, type SpawnThroughHost } from './prepare.js';
import type { SpawnThroughLaunchRequest } from './protocol.js';

const provider = {
  id: 'example',
  label: 'Example',
  resume: true,
  nativeInvocation: {
    commands: [{ name: 'example', executable: '/real/example' }],
    environmentVariables: ['EXAMPLE_HOME'],
    imposter: { state: 'isolated-root' },
  },
} satisfies AgentLaunchProvider;

const plain = { id: 'plain', label: 'Plain', resume: false } satisfies AgentLaunchProvider;

function launch(overrides: Partial<SpawnThroughLaunchRequest> = {}): SpawnThroughLaunchRequest {
  return {
    type: 'launch',
    token: 'secret',
    providerId: 'example',
    cwd: '/repo',
    argv: [],
    environment: {},
    pid: 456,
    parentPid: 123,
    ...overrides,
  };
}

const recipe = { command: '/managed/example', args: ['--managed'], cwd: '/repo', env: { INGRESS_TOKEN: 'x' } };

/** A runtime scripted to succeed, recording the order in which the host's calls arrive. */
function scripted(overrides: Partial<SpawnThroughHost> = {}, runtimeOverrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const runtime = {
    launchProviders: vi.fn(() => [provider, plain]),
    prepareInvocation: vi.fn(async () => {
      calls.push('prepare');
      return { preparationId: 'preparation-1', runtimeRunId: 'run-1', launch: recipe };
    }),
    adoptPrepared: vi.fn(async () => {
      calls.push('adopt');
      return { runtimeRunId: 'run-1', terminalSessionId: 'terminal-1', processId: 456 };
    }),
    cancelPrepared: vi.fn(async () => {
      calls.push('cancel');
      return { cancelled: true };
    }),
    ...runtimeOverrides,
  };
  const host = {
    runtime: runtime as never,
    resolveTerminal: vi.fn(async () => {
      calls.push('resolve');
      return { terminalSessionId: 'terminal-1' };
    }),
    onAdopted: vi.fn(async () => {
      calls.push('adopted');
    }),
    ...overrides,
  } satisfies SpawnThroughHost;
  return { calls, runtime, host };
}

describe('prepareSpawnThroughLaunch', () => {
  it('resolves the terminal, prepares, adopts, records — in that order — and answers exec', async () => {
    const { calls, runtime, host } = scripted();
    const result = await prepareSpawnThroughLaunch(
      launch({ argv: ['--resume', 'native-1'], environment: { EXAMPLE_HOME: '/profiles/example' } }),
      host,
    );

    expect(calls).toEqual(['resolve', 'prepare', 'adopt', 'adopted']);
    expect(host.resolveTerminal).toHaveBeenCalledWith({ pid: 456, parentPid: 123 });
    expect(runtime.prepareInvocation).toHaveBeenCalledWith({
      providerId: 'example',
      cwd: '/repo',
      argv: ['--resume', 'native-1'],
      environment: { EXAMPLE_HOME: '/profiles/example' },
      implementation: { kind: 'native' },
    });
    expect(runtime.adoptPrepared).toHaveBeenCalledWith('preparation-1', {
      runtimeRunId: 'run-1',
      terminalSessionId: 'terminal-1',
      processId: 456,
    });
    expect(host.onAdopted).toHaveBeenCalledWith({
      info: { runtimeRunId: 'run-1', terminalSessionId: 'terminal-1', processId: 456 },
      terminalSessionId: 'terminal-1',
      processId: 456,
      preparationId: 'preparation-1',
    });
    expect(result).toEqual({ action: 'exec', preparationId: 'preparation-1', launch: recipe });
  });

  it("hands the host's launch options to the preparation, and never lets them override the intent", async () => {
    const onBound = vi.fn();
    const launchOptions = vi.fn(() => ({
      title: 'typed',
      creationRequestId: 'typed-run-1',
      externalRefs: [{ namespace: 'host', kind: 'caller', id: 'pane-1' }],
      ingress: { token: 'pinned', onBound },
      // Not launch options: a host cannot rewrite what the person typed, nor slip the preparation anything else.
      providerId: 'plain',
      argv: ['--other'],
      implementation: { kind: 'imposter', executable: '/elsewhere' },
      agentOptions: { model: 'chosen-by-host' },
    }));
    const { runtime, host } = scripted({ launchOptions: launchOptions as never });
    await prepareSpawnThroughLaunch(launch({ argv: ['--typed'] }), host);

    expect(launchOptions).toHaveBeenCalledWith({
      providerId: 'example',
      cwd: '/repo',
      argv: ['--typed'],
      environment: {},
    });
    expect(runtime.prepareInvocation).toHaveBeenCalledWith({
      title: 'typed',
      creationRequestId: 'typed-run-1',
      externalRefs: [{ namespace: 'host', kind: 'caller', id: 'pane-1' }],
      ingress: { token: 'pinned', onBound },
      providerId: 'example',
      cwd: '/repo',
      argv: ['--typed'],
      environment: {},
      implementation: { kind: 'native' },
    });
  });

  it('resolves a descriptor-requested imposter root without knowing the provider', async () => {
    const { runtime, host } = scripted({
      imposterBin: () => '/opt/ai',
      imposterStateRoot: (providerId) => `/state/${providerId}`,
    });
    await expect(prepareSpawnThroughLaunch(launch({ imposter: true }), host)).resolves.toMatchObject({
      action: 'exec',
    });
    expect(runtime.prepareInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: '/state/example' },
      }),
    );
  });

  it('cancels a preparation no terminal adopted, and records nothing', async () => {
    const { calls, runtime, host } = scripted(
      {},
      {
        adoptPrepared: vi.fn(async () => ({
          error: { code: 'PREPARATION_ADOPT_FAILED', message: 'terminal is busy' },
        })),
      },
    );
    await expect(prepareSpawnThroughLaunch(launch(), host)).resolves.toEqual({
      action: 'fallback',
      reason: 'terminal is busy',
    });
    expect(runtime.cancelPrepared).toHaveBeenCalledWith('preparation-1');
    expect(host.onAdopted).not.toHaveBeenCalled();
    expect(calls).toEqual(['resolve', 'prepare', 'cancel']);
  });

  describe('declines each launch it cannot manage — fallback, or refuse with a message when strict', () => {
    const cases: {
      name: string;
      request?: Partial<SpawnThroughLaunchRequest>;
      host?: Partial<SpawnThroughHost>;
      runtime?: Record<string, unknown>;
      reason: string;
      reached: string[];
    }[] = [
      { name: 'an invalid pid', request: { pid: 0 }, reason: 'invalid process identity', reached: [] },
      { name: 'an invalid intent', request: { cwd: '' }, reason: 'invalid launch request', reached: [] },
      {
        name: 'an unknown provider',
        request: { providerId: 'missing' },
        reason: 'agent does not support managed native invocation',
        reached: [],
      },
      {
        name: 'a provider without the capability',
        request: { providerId: 'plain' },
        reason: 'agent does not support managed native invocation',
        reached: [],
      },
      {
        name: 'an imposter this host cannot run',
        request: { imposter: true },
        reason: 'the puppeteer imposter is not installed beside the host',
        reached: [],
      },
      {
        name: 'an imposter without its isolated root',
        request: { imposter: true },
        host: { imposterBin: () => '/opt/ai' },
        reason: 'an isolated imposter state root is unavailable',
        reached: [],
      },
      {
        name: 'a process no terminal of the host contains',
        host: { resolveTerminal: async () => undefined },
        reason: 'containing terminal was not found',
        reached: [],
      },
      {
        name: 'a failed preparation (a rejected normalization among them)',
        runtime: {
          prepareInvocation: async () => ({
            error: {
              code: 'INVALID_NATIVE_INVOCATION',
              message: 'custom arguments are not compatible with the managed launch',
            },
          }),
        },
        reason: 'custom arguments are not compatible with the managed launch',
        reached: ['resolve'],
      },
      {
        name: 'a failed adoption',
        runtime: {
          adoptPrepared: async () => ({ error: { code: 'PREPARATION_ADOPT_FAILED', message: 'terminal is busy' } }),
        },
        reason: 'terminal is busy',
        reached: ['resolve', 'prepare', 'cancel'],
      },
    ];

    for (const strict of [false, true]) {
      for (const testCase of cases) {
        it(`${testCase.name} (${strict ? 'strict' : 'not strict'})`, async () => {
          const { calls, host } = scripted({ ...testCase.host, strict }, testCase.runtime);
          const result = await prepareSpawnThroughLaunch(launch(testCase.request), host);
          expect(result).toEqual(
            strict
              ? {
                  action: 'refuse',
                  reason: testCase.reason,
                  message: `not started, because it could not be run as a managed session: ${testCase.reason}`,
                }
              : { action: 'fallback', reason: testCase.reason },
          );
          expect(calls).toEqual(testCase.reached);
          expect(host.onAdopted).not.toHaveBeenCalled();
        });
      }
    }
  });
});
