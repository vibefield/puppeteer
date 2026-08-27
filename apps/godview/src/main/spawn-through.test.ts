import { once } from 'node:events';
import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { unknownSessionActivity, type SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentLaunchProvider } from '@vibecook/puppeteer-core';
import {
  matchingTerminalSession,
  parseSpawnThroughRequest,
  prepareSpawnThroughLaunch,
  startSpawnThroughGateway,
  type SpawnThroughLaunchRequest,
} from './spawn-through.js';

const shellSession = {
  id: 'terminal-1',
  handle: '1',
  executable: '/bin/zsh',
  cols: 100,
  rows: 30,
  exited: false,
  readWrite: true,
  title: null,
  cwd: '/repo',
  bellCount: 0,
  pid: 123,
  createdAtMs: 1,
  exitCode: null,
  exitSignal: null,
  requestedTermination: null,
  exitOutcome: null,
  ownerId: null,
  persistence: 'terminate-with-app',
  activity: unknownSessionActivity(),
} satisfies SessionSummary;

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

function prepared() {
  return {
    preparationId: 'preparation-1',
    agent: 'example',
    sessionId: 'native-1',
    launch: { command: '/managed/example', args: ['--managed'], cwd: '/repo' },
    workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

describe('Godview spawn-through host', () => {
  it('closes promptly even when a client leaves an incomplete request open', async () => {
    const gateway = await startSpawnThroughGateway('secret', async () => ({ action: 'ack' }));
    const socket = connect(gateway.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('{"token":"secret"');
    socket.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

    await expect(gateway.close()).resolves.toBeUndefined();
    await closed;
  });

  it('validates the gateway payload strictly before routing it', () => {
    expect(parseSpawnThroughRequest(launch())).toEqual(launch());
    expect(parseSpawnThroughRequest({ ...launch(), providerSpecificOption: true })).toBeUndefined();
    expect(parseSpawnThroughRequest({ ...launch(), environment: { 'NOT VALID': 'x' } })).toBeUndefined();
    expect(
      parseSpawnThroughRequest({ type: 'exec-failed', token: 'secret', preparationId: 'p-1', message: 'boom' }),
    ).toEqual({ type: 'exec-failed', token: 'secret', preparationId: 'p-1', message: 'boom' });
  });

  it('matches a direct shell child and the shell-exec optimization', () => {
    expect(matchingTerminalSession([shellSession], { pid: 456, parentPid: 123 })?.id).toBe('terminal-1');
    expect(matchingTerminalSession([shellSession], { pid: 123, parentPid: 9 })?.id).toBe('terminal-1');
  });

  it('passes native intent to the runtime and only owns terminal adoption', async () => {
    const recipe = prepared();
    const prepareInvocation = vi.fn().mockResolvedValue(recipe);
    const adoptPrepared = vi.fn().mockResolvedValue({
      ...recipe,
      runtimeSessionId: 'terminal-1',
      processId: 456,
    });
    const onAdopted = vi.fn();
    const result = await prepareSpawnThroughLaunch(
      launch({ argv: ['--resume', 'native-1'], environment: { EXAMPLE_HOME: '../profile' } }),
      {
        runtime: {
          launchProviders: () => [provider],
          prepareInvocation,
          adoptPrepared,
          cancelPrepared: vi.fn(),
        } as never,
        listSessions: async () => [shellSession],
        onAdopted,
      },
    );

    expect(prepareInvocation).toHaveBeenCalledWith({
      providerId: 'example',
      cwd: '/repo',
      argv: ['--resume', 'native-1'],
      environment: { EXAMPLE_HOME: '../profile' },
      implementation: { kind: 'native' },
    });
    expect(adoptPrepared).toHaveBeenCalledWith('preparation-1', {
      runtimeSessionId: 'terminal-1',
      processId: 456,
    });
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'exec', preparationId: 'preparation-1', launch: recipe.launch });
  });

  it('resolves a descriptor-requested imposter root without knowing the provider', async () => {
    const recipe = prepared();
    const prepareInvocation = vi.fn().mockResolvedValue(recipe);
    const result = await prepareSpawnThroughLaunch(launch({ imposter: true }), {
      runtime: {
        launchProviders: () => [provider],
        prepareInvocation,
        adoptPrepared: vi.fn().mockResolvedValue({ ...recipe, runtimeSessionId: 'terminal-1', processId: 456 }),
        cancelPrepared: vi.fn(),
      } as never,
      imposterBin: () => '/opt/ai',
      imposterStateRoot: () => '/tmp/example-imposter',
      listSessions: async () => [shellSession],
      onAdopted: vi.fn(),
    });

    expect(prepareInvocation).toHaveBeenCalledWith({
      providerId: 'example',
      cwd: '/repo',
      argv: [],
      environment: {},
      implementation: {
        kind: 'imposter',
        executable: '/opt/ai',
        stateRoot: '/tmp/example-imposter',
      },
    });
    expect(result).toEqual({ action: 'exec', preparationId: 'preparation-1', launch: recipe.launch });
  });

  it('refuses an unavailable imposter instead of silently changing implementation', async () => {
    const prepareInvocation = vi.fn();
    const result = await prepareSpawnThroughLaunch(launch({ imposter: true }), {
      runtime: {
        launchProviders: () => [provider],
        prepareInvocation,
      } as never,
      imposterBin: () => undefined,
      listSessions: async () => [shellSession],
      onAdopted: vi.fn(),
    });
    expect(result).toMatchObject({ action: 'fallback' });
    expect(prepareInvocation).not.toHaveBeenCalled();
  });

  it('cancels a prepared adapter when terminal adoption fails', async () => {
    const recipe = prepared();
    const cancelPrepared = vi.fn().mockResolvedValue({ cancelled: true });
    const result = await prepareSpawnThroughLaunch(launch(), {
      runtime: {
        launchProviders: () => [provider],
        prepareInvocation: vi.fn().mockResolvedValue(recipe),
        adoptPrepared: vi.fn().mockResolvedValue({ error: { code: 'PREPARATION_ADOPT_FAILED', message: 'busy' } }),
        cancelPrepared,
      } as never,
      listSessions: async () => [shellSession],
      onAdopted: vi.fn(),
    });

    expect(cancelPrepared).toHaveBeenCalledWith('preparation-1');
    expect(result).toEqual({ action: 'fallback', reason: 'busy' });
  });
});
