import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibecook/puppeteer-core';
import { createAgentRuntime, type AgentRuntime } from '@vibecook/puppeteer-runtime';
import { prepareSpawnThroughLaunch, type SpawnThroughLaunchRequest } from '@vibecook/puppeteer-runtime/spawn-through';
import { createBuiltinProviders } from './providers.js';

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

const vendors = ['claude', 'codex', 'grok', 'kimi', 'opencode', 'hermes', 'antigravity', 'copilot', 'pi'];
const nonSessions = [
  ['grok', ['-p', 'hello']],
  ['kimi', ['--prompt', 'hello']],
  ['opencode', ['run', 'hello']],
  ['hermes', ['chat', '-q', 'hello', '--oneshot']],
  ['antigravity', ['--print', 'hello']],
  ['copilot', ['--prompt', 'hello']],
  ['pi', ['--mode', 'json']],
  ['grok', ['agent', 'stdio']],
  ['kimi', ['acp']],
  ['opencode', ['attach', 'http://localhost:9999']],
  ['hermes', ['serve']],
  ['antigravity', ['remote-control', 'status']],
  ['copilot', ['--connect']],
  ['pi', ['--mode', 'rpc']],
] as const;

function setup(providerId: string, argv: string[] = []) {
  const terminalHost = { spawnTerminal: vi.fn(), automateTerminal: vi.fn() } as unknown as AgentHost;
  const runtime = createAgentRuntime({
    host: terminalHost,
    defaultCwd: '/scratch',
    providers: createBuiltinProviders(),
  });
  runtimes.push(runtime);
  // Actual builtin grammar + runtime validation; replace only the process-creating boundary.
  const prepare = vi.spyOn(runtime, 'prepareInvocation');
  const resolveTerminal = vi.fn(async (): Promise<{ terminalSessionId: string } | undefined> => ({
    terminalSessionId: 'pane',
  }));
  const host = { runtime, strict: true, resolveTerminal, onAdopted: vi.fn() };
  const request: SpawnThroughLaunchRequest = {
    type: 'launch',
    token: 'test',
    providerId,
    cwd: '/scratch',
    argv,
    environment: {},
    pid: 456,
    parentPid: 123,
    interactive: true,
  };
  return { runtime, terminalHost, prepare, host, request };
}

describe('the strict host consumes the real builtin adapter grammars', () => {
  it('offers classification for every vendor and no native launcher for protocol-only ACP', () => {
    const { runtime } = setup('grok');
    expect(
      runtime
        .launchProviders()
        .filter((row) => row.nativeInvocation?.classifies)
        .map((row) => row.id)
        .sort(),
    ).toEqual([...vendors].sort());
    expect(runtime.launchProviders().find((row) => row.id === 'acp')?.nativeInvocation).toBeUndefined();
  });

  it.each(vendors)('%s help passes without process placement or preparation', async (id) => {
    const { host, request, prepare, terminalHost } = setup(id, ['--help']);
    expect(await prepareSpawnThroughLaunch(request, host)).toMatchObject({ action: 'fallback', code: 'passthrough' });
    expect(host.resolveTerminal).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(terminalHost.spawnTerminal).not.toHaveBeenCalled();
  });

  it.each(nonSessions)('%s non-session %j passes through before custody', async (id, argv) => {
    const { host, request, prepare } = setup(id, [...argv]);
    expect(await prepareSpawnThroughLaunch(request, host)).toMatchObject({ action: 'fallback', code: 'passthrough' });
    expect(host.resolveTerminal).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(vendors)('%s refuses unknown interactive intent only inside the host terminal', async (id) => {
    const { host, request, prepare } = setup(id, ['--unknown-future-option']);
    expect(await prepareSpawnThroughLaunch(request, host)).toMatchObject({
      action: 'refuse',
      code: 'rejected-argument',
      placed: true,
    });
    expect(prepare).not.toHaveBeenCalled();
    host.resolveTerminal.mockResolvedValue(undefined);
    expect(await prepareSpawnThroughLaunch(request, host)).toMatchObject({
      action: 'fallback',
      code: 'outside-host-terminals',
    });
    host.resolveTerminal.mockClear();
    expect(await prepareSpawnThroughLaunch({ ...request, interactive: false }, host)).toMatchObject({
      action: 'fallback',
      code: 'not-interactive',
    });
    expect(host.resolveTerminal).not.toHaveBeenCalled();
  });

  it.each(vendors)('%s bare invocation reaches preparation, adoption and the in-place exec', async (id) => {
    const { runtime, host, request, prepare, terminalHost } = setup(id);
    const launch = { command: '/fixture/native-agent', args: [], cwd: '/scratch' };
    prepare.mockResolvedValue({ preparationId: 'prepared', runtimeRunId: 'run', launch } as never);
    const adopt = vi
      .spyOn(runtime, 'adoptPrepared')
      .mockResolvedValue({ runtimeRunId: 'run', terminalSessionId: 'pane', processId: 456 } as never);
    expect(await prepareSpawnThroughLaunch(request, host)).toEqual({
      action: 'exec',
      preparationId: 'prepared',
      launch,
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: id, argv: [], implementation: { kind: 'native' } }),
    );
    expect(adopt).toHaveBeenCalledWith('prepared', { runtimeRunId: 'run', terminalSessionId: 'pane', processId: 456 });
    expect(host.onAdopted).toHaveBeenCalledOnce();
    expect(terminalHost.spawnTerminal).not.toHaveBeenCalled();
  });
});
