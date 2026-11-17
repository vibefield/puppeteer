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
  statFails: false,
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
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (mocks.statFails && String(args[0]).endsWith('updates.jsonl')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return actual.statSync(...args);
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
    mocks.statFails = false;
    mocks.spawn.mockReturnValue({ exitCode: null, signalCode: null, killed: false, kill: vi.fn(), once: vi.fn() });
    mocks.createAcpSession.mockImplementation(async (options: { resume?: string }) =>
      controlSession(options.resume ?? 'materialized-session'),
    );
  });

  it.each([false, true])(
    'carries per-run MCP declarations into ACP before the viewer joins (resume=%s)',
    async (resume) => {
      const backend = createGrokBackend({ executable: '/real/grok', host: host() });
      const mcpServers = { field: { command: 'door', env: { TOKEN: 'secret' } } };
      try {
        const prepared = await backend.prepareSession({
          cwd: '/repo',
          mcpServers,
          ...(resume ? { resume: 'existing' } : {}),
        });
        expect(mocks.createAcpSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers }));
        expect(JSON.stringify(prepared.launch)).not.toContain('secret');
        await prepared.dispose();
      } finally {
        backend.dispose();
      }
    },
  );

  describe('a briefed run names its own leader', () => {
    const mcpServers = { field: { command: 'door', env: { TOKEN: 'secret' } } };
    /** A leader that exits as soon as it is signalled. */
    function leaderProcess(pid: number) {
      const exits: Array<() => void> = [];
      const child = {
        pid,
        exitCode: null as number | null,
        signalCode: null,
        killed: false,
        kill: vi.fn(() => {
          child.exitCode = 143;
          queueMicrotask(() => exits.splice(0).forEach((exit) => exit()));
          return true;
        }),
        once: vi.fn((event: string, listener: () => void) => {
          if (event === 'exit') exits.push(listener);
          return child;
        }),
      };
      return child;
    }
    const leaderArgs = (call: number): string[] => mocks.spawn.mock.calls[call]![1] as string[];
    const socketOf = (args: string[]): string => args[args.indexOf('--leader-socket') + 1]!;

    it('gives each briefed run a leader of its own, and leaves no briefing on the shared one', async () => {
      const backend = createGrokBackend({ executable: '/real/grok', host: host() });
      try {
        const [plain, again] = [
          await backend.prepareSession({ cwd: '/a' }),
          await backend.prepareSession({ cwd: '/b' }),
        ];
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        const one = await backend.prepareSession({ cwd: '/c', mcpServers });
        const two = await backend.prepareSession({ cwd: '/d', mcpServers });
        expect(mocks.spawn).toHaveBeenCalledTimes(3);
        expect(new Set([socketOf(leaderArgs(0)), socketOf(leaderArgs(1)), socketOf(leaderArgs(2))]).size).toBe(3);
        // The viewer joins the leader that holds its run's MCP servers.
        expect(socketOf(one.launch.args)).toBe(socketOf(leaderArgs(1)));
        expect(socketOf(two.launch.args)).toBe(socketOf(leaderArgs(2)));
        expect(socketOf(plain.launch.args)).toBe(socketOf(leaderArgs(0)));
        await Promise.all([plain.dispose(), again.dispose(), one.dispose(), two.dispose()]);
      } finally {
        await backend.dispose();
      }
    });

    it('keeps an empty server map on the shared leader: nothing there needs naming', async () => {
      const onHelperProcess = vi.fn();
      const backend = createGrokBackend({ executable: '/real/grok', host: host() });
      try {
        const prepared = await backend.prepareSession({ cwd: '/a', mcpServers: {}, ingress: { onHelperProcess } });
        await backend.prepareSession({ cwd: '/b' });
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(onHelperProcess).not.toHaveBeenCalled();
        await prepared.dispose();
      } finally {
        await backend.dispose();
      }
    });

    it('holds ACP until the host has the leader pid, on the run leader only', async () => {
      const child = leaderProcess(7001);
      mocks.spawn.mockReturnValue(child);
      let answer!: () => void;
      const onHelperProcess = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)));
      const before = Date.now();
      const backend = createGrokBackend({ executable: '/real/grok', host: host() });
      try {
        const preparing = backend.prepareSession({ cwd: '/a', mcpServers, ingress: { onHelperProcess } });
        await vi.waitFor(() => expect(onHelperProcess).toHaveBeenCalledOnce());
        expect(onHelperProcess).toHaveBeenCalledWith({ pid: 7001, startedAtMs: expect.any(Number) });
        const { startedAtMs } = (onHelperProcess.mock.calls[0] as unknown as [{ startedAtMs: number }])[0];
        expect(startedAtMs).toBeGreaterThanOrEqual(before);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(mocks.createAcpSession).not.toHaveBeenCalled();
        answer();
        const prepared = await preparing;
        expect(mocks.createAcpSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers }));
        await prepared.dispose();
      } finally {
        await backend.dispose();
      }
    });

    it("runs a run's leader under the one helper environment the shared leader has", async () => {
      const helperEnvironment = vi.fn((env: Record<string, string>) => ({ PATH: '/agent/bin', ...env }));
      const backend = createGrokBackend({ executable: '/real/grok', host: { ...host(), helperEnvironment } });
      try {
        const prepared = await backend.prepareSession({ cwd: '/a', mcpServers });
        expect(helperEnvironment).toHaveBeenCalledTimes(1);
        expect(mocks.spawn).toHaveBeenCalledWith('/real/grok', expect.arrayContaining(['agent', 'leader']), {
          stdio: 'ignore',
          env: { PATH: '/agent/bin' },
        });
        await prepared.dispose();
      } finally {
        await backend.dispose();
      }
    });

    it('refuses the launch honestly when the hook throws, and drains the leader it started', async () => {
      const child = leaderProcess(7002);
      mocks.spawn.mockReturnValue(child);
      const backend = createGrokBackend({ executable: '/real/grok', host: host() });
      try {
        await expect(
          backend.prepareSession({
            cwd: '/a',
            mcpServers,
            ingress: { onHelperProcess: () => Promise.reject(new Error('no')) },
          }),
        ).rejects.toMatchObject({ code: 'RUN_HELPER_UNNAMED' });
        expect(mocks.createAcpSession).not.toHaveBeenCalled();
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      } finally {
        await backend.dispose();
      }
    });

    it('drains the leader with its run: an unadopted preparation, then an adopted binding', async () => {
      const first = leaderProcess(7003);
      const second = leaderProcess(7004);
      mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
      const backend = createGrokBackend({ executable: '/real/grok', host: host() });
      try {
        const unadopted = await backend.prepareSession({ cwd: '/a', mcpServers });
        await unadopted.dispose();
        expect(first.kill).toHaveBeenCalledWith('SIGTERM');

        const prepared = await backend.prepareSession({ cwd: '/b', mcpServers });
        const control = await mocks.createAcpSession.mock.results.at(-1)!.value;
        const binding = await prepared.adopt('terminal-2');
        await vi.waitFor(() => expect(mocks.createAcpSession).toHaveBeenCalledTimes(2));
        expect(second.kill).not.toHaveBeenCalled();
        await binding.dispose();
        // Control leaves first: the leader drains with nobody still talking to it.
        expect(control.dispose).toHaveBeenCalledOnce();
        expect((control.dispose as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
          second.kill.mock.invocationCallOrder[0]!,
        );
        expect(second.kill).toHaveBeenCalledWith('SIGTERM');
      } finally {
        await backend.dispose();
      }
    });

    describe('a resume and a leader still draining', () => {
      /** A leader that takes its signal and keeps draining until the test says it has exited. */
      function drainingLeader(pid: number) {
        const exits: Array<() => void> = [];
        const child = {
          pid,
          exitCode: null as number | null,
          signalCode: null,
          killed: false,
          kill: vi.fn(() => true),
          once: vi.fn((event: string, listener: () => void) => {
            if (event === 'exit') exits.push(listener);
            return child;
          }),
          exit() {
            child.exitCode = 143;
            exits.splice(0).forEach((exit) => exit());
          },
        };
        return child;
      }
      const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

      it("starts a resuming run's leader only after the old leader has exited", async () => {
        const old = drainingLeader(7101);
        mocks.spawn.mockReturnValueOnce(old).mockReturnValueOnce(leaderProcess(7102));
        const backend = createGrokBackend({ executable: '/real/grok', host: host() });
        try {
          const first = await backend.prepareSession({ cwd: '/a', mcpServers });
          const stopping = first.dispose();
          await vi.waitFor(() => expect(old.kill).toHaveBeenCalledWith('SIGTERM'));
          const resuming = backend.prepareSession({ cwd: '/a', mcpServers, resume: 'old-session' });
          await settle();
          expect(mocks.spawn).toHaveBeenCalledTimes(1);
          old.exit();
          await stopping;
          const resumed = await resuming;
          expect(mocks.spawn).toHaveBeenCalledTimes(2);
          await resumed.dispose();
        } finally {
          await backend.dispose();
        }
      });

      it('waits from the moment the run begins to stop, while its control is still closing', async () => {
        const old = drainingLeader(7103);
        mocks.spawn.mockReturnValueOnce(old);
        let closed!: () => void;
        const control = controlSession('materialized-session');
        control.dispose = vi.fn(() => new Promise<void>((resolve) => (closed = resolve)));
        mocks.createAcpSession.mockImplementationOnce(async () => control);
        const backend = createGrokBackend({ executable: '/real/grok', host: host() });
        try {
          const prepared = await backend.prepareSession({ cwd: '/a', mcpServers });
          const binding = await prepared.adopt('terminal-1');
          const disposing = binding.dispose();
          await vi.waitFor(() => expect(control.dispose).toHaveBeenCalledOnce());
          // A resume on the shared leader waits too: the old run's leader still writes this session.
          const resuming = backend.prepareSession({ cwd: '/a', resume: 'old-session' });
          await settle();
          expect(mocks.spawn).toHaveBeenCalledTimes(1);
          expect(mocks.createAcpSession).toHaveBeenCalledTimes(1);
          closed();
          await vi.waitFor(() => expect(old.kill).toHaveBeenCalledWith('SIGTERM'));
          await settle();
          expect(mocks.spawn).toHaveBeenCalledTimes(1);
          old.exit();
          await disposing;
          const resumed = await resuming;
          expect(mocks.spawn).toHaveBeenCalledTimes(2);
          await resumed.dispose();
        } finally {
          await backend.dispose();
        }
      });

      it('holds a fresh run for nobody', async () => {
        const old = drainingLeader(7104);
        mocks.spawn.mockReturnValueOnce(old).mockReturnValueOnce(leaderProcess(7105));
        const backend = createGrokBackend({ executable: '/real/grok', host: host() });
        try {
          const first = await backend.prepareSession({ cwd: '/a', mcpServers });
          const stopping = first.dispose();
          await vi.waitFor(() => expect(old.kill).toHaveBeenCalledWith('SIGTERM'));
          const fresh = await backend.prepareSession({ cwd: '/b', mcpServers });
          expect(mocks.spawn).toHaveBeenCalledTimes(2);
          old.exit();
          await stopping;
          await fresh.dispose();
        } finally {
          await backend.dispose();
        }
      });
    });

    it('stops a run leader the backend still holds when the backend goes', async () => {
      const child = leaderProcess(7005);
      mocks.spawn.mockReturnValue(child);
      const backend = createGrokBackend({ executable: '/real/grok', host: host() });
      await backend.prepareSession({ cwd: '/a', mcpServers });
      await backend.dispose();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('under withhold', () => {
    const mcpServers = { field: { command: 'door' } };

    it('launches an imposter bare and says so, on the shared leader', async () => {
      const backend = createGrokBackend({
        executable: '/real/grok',
        host: host(),
        appServerEnv: { AI_PERSONA: 'grok', PUPPETEER_IMPOSTER_HOME: '/tmp/imposter-withhold' },
      });
      try {
        const prepared = await backend.prepareSession({ cwd: '/repo', mcpServers, briefingRefusal: 'withhold' });
        expect(prepared.briefingWithheld).toEqual([{ field: 'mcpServers', code: 'UNSUPPORTED_LAUNCH_FIELD' }]);
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(mocks.createAcpSession.mock.calls[0]![0]).not.toHaveProperty('mcpServers');
        await prepared.dispose();
      } finally {
        await backend.dispose();
      }
    });

    it('withholds instructions Grok has no field for, and keeps the servers on their own leader', async () => {
      const backend = createGrokBackend({ executable: '/real/grok', host: host() });
      try {
        const prepared = await backend.prepareSession({
          cwd: '/repo',
          mcpServers,
          instructions: 'role',
          briefingRefusal: 'withhold',
        });
        expect(prepared.briefingWithheld).toEqual([{ field: 'instructions', code: 'UNSUPPORTED_LAUNCH_FIELD' }]);
        expect(mocks.createAcpSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers }));
        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        await prepared.dispose();
      } finally {
        await backend.dispose();
      }
    });

    it('says nothing when nothing was withheld', async () => {
      const backend = createGrokBackend({ executable: '/real/grok', host: host() });
      try {
        const prepared = await backend.prepareSession({ cwd: '/repo', briefingRefusal: 'withhold' });
        expect(prepared).not.toHaveProperty('briefingWithheld');
        await prepared.dispose();
      } finally {
        await backend.dispose();
      }
    });
  });

  it('refuses instructions before starting the shared leader', async () => {
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    try {
      await expect(backend.prepareSession({ cwd: '/repo', instructions: 'role' })).rejects.toMatchObject({
        code: 'UNSUPPORTED_LAUNCH_FIELD',
      });
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.createAcpSession).not.toHaveBeenCalled();
    } finally {
      backend.dispose();
    }
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

  it("runs the leader and its ACP controller under the host's helper environment when the host composes one", async () => {
    vi.stubEnv('PUPPETEER_HOST_ONLY_SECRET', 'host-secret');
    const helperEnvironment = vi.fn((env: Record<string, string>) => ({ PATH: '/agent/bin', ...env }));
    const backend = createGrokBackend({ executable: '/real/grok', host: { ...host(), helperEnvironment } });
    try {
      const prepared = await backend.prepareSession({ cwd: '/repo' });
      expect(helperEnvironment).toHaveBeenCalledWith({});
      // exactly the host's composition: nothing of this process's own is merged back
      expect(mocks.spawn).toHaveBeenCalledWith('/real/grok', expect.arrayContaining(['agent', 'leader']), {
        stdio: 'ignore',
        env: { PATH: '/agent/bin' },
      });
      expect(mocks.createStdioAcpConnector).toHaveBeenCalledWith(
        expect.objectContaining({ env: { PATH: '/agent/bin' } }),
      );
      await prepared.dispose();
    } finally {
      backend.dispose();
      vi.unstubAllEnvs();
    }
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

  it('rejects a resume whose log cannot be measured, and disposes the control it opened', async () => {
    // A resume's replay boundary is its log's size once control holds the session. A log that exists but cannot be
    // measured is never guessed at: preparation fails, and the control it opened goes with it.
    const control = controlSession('existing');
    mocks.createAcpSession.mockImplementationOnce(async () => control);
    mocks.statFails = true;
    const backend = createGrokBackend({ executable: '/real/grok', host: host() });
    try {
      await expect(backend.prepareSession({ cwd: '/repo', resume: 'existing' })).rejects.toMatchObject({
        code: 'EACCES',
      });
      expect(control.dispose).toHaveBeenCalledTimes(1);
    } finally {
      backend.dispose();
    }
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
