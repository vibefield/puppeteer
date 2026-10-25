import { rmSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapterBinding, AgentHost } from '@vibefield/puppeteer-core';
import { projectAgentEvents } from '@vibefield/puppeteer-testing';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  createAcpSession: vi.fn(),
  createStdioAcpConnector: vi.fn(() => ({ connector: 'fake' })),
  socketReady: true,
  removeFails: false,
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      (/leader\.(sock|lock)$/.test(String(path)) && mocks.socketReady) || actual.existsSync(path),
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (mocks.removeFails && String(args[0]).includes('puppeteer-grok-imposter-home-')) {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return actual.rmSync(...args);
    },
  };
});
vi.mock('@vibefield/puppeteer-adapter-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vibefield/puppeteer-adapter-acp')>()),
  createAcpSession: mocks.createAcpSession,
  createStdioAcpConnector: mocks.createStdioAcpConnector,
}));

import { createGrokBackend } from './driver.js';
import { grokDeferredApprovalEvidence } from './normalization/interaction.js';
import { openGrokControl } from './services/acp-control.js';

function controlSession(sessionId: string): AgentAdapterBinding {
  return {
    sessionId,
    runtimeSessionId: `control-${sessionId}`,
    observationLevel: () => 'structured',
    events: { onCandidate: () => () => undefined },
    services: { prompt: { submit: async () => ({ status: 'confirmed', turnId: 'turn-1' }) } },
    dispose: vi.fn(async () => undefined),
  };
}

function host(): AgentHost & { spawnTerminal: ReturnType<typeof vi.fn> } {
  return {
    spawnTerminal: vi.fn(async () => ({ runtimeSessionId: 'terminal-1' })),
    automateTerminal: vi.fn(async () => ({ accepted: true as const })),
  };
}

describe('Grok leader session materialization ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.socketReady = true;
    mocks.removeFails = false;
    mocks.spawn.mockReturnValue({ exitCode: null, signalCode: null, killed: false, kill: vi.fn(), once: vi.fn() });
    mocks.createAcpSession.mockImplementation(async (options: { resume?: string }) =>
      controlSession(options.resume ?? 'materialized-session'),
    );
  });

  it('materializes a fresh ACP session before returning a TUI recipe that resumes it', async () => {
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    const prepared = await backend.prepareSession({ cwd: '/repo' });

    expect(mocks.createAcpSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo' }));
    expect(mocks.createAcpSession.mock.calls[0]![0]).not.toHaveProperty('resume');
    expect(prepared.sessionId).toBe('materialized-session');
    expect(prepared.launch).toEqual({
      command: '/real/grok',
      args: expect.arrayContaining(['--resume', 'materialized-session']),
      cwd: '/repo',
    });
    expect(prepared.launch.args).not.toContain('--session-id');

    const adopted = await prepared.adopt('terminal-1');
    const projection = projectAgentEvents(adopted);
    await vi.waitFor(() => expect(projection.state.lifecycle).toBe('ready'));
    projection.dispose();
    await prepared.dispose();
    backend.dispose();
  });

  it('opens structured control before the managed host spawns the TUI', async () => {
    const terminalHost = host();
    const backend = createGrokBackend({ executable: '/real/grok', host: terminalHost });
    const session = await backend.createSession({ cwd: '/repo' });
    const projection = projectAgentEvents(session);

    expect(mocks.createAcpSession.mock.invocationCallOrder[0]).toBeLessThan(
      terminalHost.spawnTerminal.mock.invocationCallOrder[0]!,
    );
    expect(terminalHost.spawnTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.arrayContaining(['--resume', 'materialized-session']) }),
    );
    await vi.waitFor(() => expect(projection.state.lifecycle).toBe('ready'));
    projection.dispose();
    await session.dispose();
    backend.dispose();
  });

  it('defers unhandled approvals to the native viewer every prepared session launches', async () => {
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    const prepared = await backend.prepareSession({ cwd: '/repo' });
    const onApproval = vi.fn(() => 'approved' as const);
    const handled = await backend.prepareSession({ cwd: '/repo', onApproval });

    // The recipe always joins the controller's leader session with the viewer.
    expect(prepared.launch.args).toEqual(expect.arrayContaining(['--leader', '--resume', prepared.sessionId]));
    expect(mocks.createAcpSession.mock.calls[0]![0]).toMatchObject({
      unhandledApproval: 'defer',
      deferredApprovalEvidence: grokDeferredApprovalEvidence,
    });
    expect(mocks.createAcpSession.mock.calls[0]![0]).toHaveProperty('onApproval', undefined);
    // A host handler still decides; adapter-acp applies the policy only without one.
    expect(mocks.createAcpSession.mock.calls[1]![0]).toMatchObject({ onApproval, unhandledApproval: 'defer' });
    await Promise.all([prepared.dispose(), handled.dispose()]);
    backend.dispose();
  });

  it('keeps the immediate deny for a controller-only composition', async () => {
    await openGrokControl('/real/grok', '/repo', '/tmp/leader.sock', undefined, {});
    expect(mocks.createAcpSession.mock.calls[0]![0]).toMatchObject({ unhandledApproval: 'deny' });
    await openGrokControl('/real/grok', '/repo', '/tmp/leader.sock', undefined, {}, undefined, { viewer: 'attached' });
    expect(mocks.createAcpSession.mock.calls[1]![0]).toMatchObject({ unhandledApproval: 'defer' });
  });

  it('loads an explicit resume id before launching the matching TUI', async () => {
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    const prepared = await backend.prepareSession({ cwd: '/repo', resume: 'existing-session' });

    expect(mocks.createAcpSession).toHaveBeenCalledWith(expect.objectContaining({ resume: 'existing-session' }));
    expect(prepared.sessionId).toBe('existing-session');
    expect(prepared.launch.args).toEqual(expect.arrayContaining(['--resume', 'existing-session']));
    await prepared.dispose();
    backend.dispose();
  });

  it('starts the shared leader only once when preparations overlap', async () => {
    mocks.socketReady = false;
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    const first = backend.prepareSession({ cwd: '/repo/one' });
    const second = backend.prepareSession({ cwd: '/repo/two' });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    mocks.socketReady = true;
    const [firstPrepared, secondPrepared] = await Promise.all([first, second]);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.createAcpSession).toHaveBeenCalledTimes(2);
    await Promise.all([firstPrepared.dispose(), secondPrepared.dispose()]);
    backend.dispose();
  });

  it('refuses work after disposal without spawning a leader', async () => {
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    backend.dispose();

    await expect(backend.prepareSession({ cwd: '/repo' })).rejects.toThrow('backend is disposed');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('kills and rejects an in-flight leader when disposal races startup', async () => {
    mocks.socketReady = false;
    const kill = vi.fn();
    mocks.spawn.mockReturnValue({ exitCode: null, signalCode: null, killed: false, kill, once: vi.fn() });
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    const preparing = backend.prepareSession({ cwd: '/repo' });

    backend.dispose();

    await expect(preparing).rejects.toThrow('disposed while its leader was starting');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(mocks.createAcpSession).not.toHaveBeenCalled();
  });
  it('never rejects disposal when the adapter-owned Imposter home cannot be removed', async () => {
    // builtin-providers disposes backends without awaiting them, so a failed
    // best-effort cleanup must not surface as an unhandled rejection.
    const backend = createGrokBackend({ executable: '/real/grok', host: host(), appServerEnv: { AI_PERSONA: 'grok' } });
    const home = (await backend.prepareSession({ cwd: '/repo' })).launch.env?.GROK_HOME;
    expect(home).toContain('puppeteer-grok-imposter-home-');
    mocks.removeFails = true;
    await expect(backend.dispose()).resolves.toBeUndefined();
    mocks.removeFails = false;
    rmSync(home!, { recursive: true, force: true });
  });
});
