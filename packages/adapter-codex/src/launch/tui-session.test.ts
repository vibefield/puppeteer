import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEventCandidate, AgentHost } from '@vibefield/puppeteer-core';

const fakes = vi.hoisted(() => {
  const observerListeners = new Set<(candidate: AdapterEventCandidate) => void>();
  return {
    createObserver: vi.fn(),
    observerListeners,
    observerOnCandidate: vi.fn((listener: (candidate: AdapterEventCandidate) => void) => {
      observerListeners.add(listener);
      return () => {
        observerListeners.delete(listener);
      };
    }),
    observerDispose: vi.fn(),
    observerOnThread: vi.fn((_listener: (info: { threadId: string }) => void) => () => true),
    observerSettingsUpdated: vi.fn(),
    serverDispose: vi.fn(),
    serverReady: vi.fn(),
    spawnServer: vi.fn(),
    transport: {},
    tapReady: vi.fn(),
    tapDispose: vi.fn(),
    tapClientMessage: undefined as ((message: unknown) => void) | undefined,
    tapServerReader: undefined as { waiting(): boolean; message(message: unknown): void } | undefined,
  };
});

vi.mock('../observation/observer.js', () => ({
  createCodexObserver: fakes.createObserver,
}));

vi.mock('../transport/app-server-process.js', () => ({
  spawnAppServer: fakes.spawnServer,
}));

vi.mock('../transport/ws-transport.js', () => ({
  connectAppServerEndpoint: vi.fn(() => fakes.transport),
  appServerRemoteAddress: vi.fn((endpoint: { kind: string; path?: string; url?: string }) =>
    endpoint.kind === 'unix' ? `unix://${endpoint.path}` : endpoint.url,
  ),
  createWebSocketTapProxy: vi.fn(
    (
      _upstream: { kind: string; path?: string; url?: string },
      onClientMessage: (message: unknown) => void,
      onServerMessage?: { waiting(): boolean; message(message: unknown): void },
    ) => {
      fakes.tapClientMessage = onClientMessage;
      fakes.tapServerReader = onServerMessage;
      return {
        endpoint: () => ({ kind: 'unix', path: '/tmp/codex-tap.sock' }),
        ready: fakes.tapReady,
        dispose: fakes.tapDispose,
      };
    },
  ),
}));

import { createCodexTuiSession, prepareCodexTuiSession } from './tui-session.js';

function host(): AgentHost {
  return {
    spawnTerminal: vi.fn(async () => ({ runtimeSessionId: 'spawned-pane' })),
    automateTerminal: vi.fn(async () => ({ accepted: true as const })),
  };
}

/** The observer publishes the thread's record of a submitted input as `turn:started` with its text. */
function threadRecords(prompt: string, turnId: string): void {
  const candidate: AdapterEventCandidate = {
    type: 'turn:started',
    sessionId: 'thread-1',
    timestamp: '2026-11-19T00:00:00.000Z',
    monotonicTime: 0,
    source: 'native-hook',
    confidence: 'authoritative',
    event: { type: 'turn:started', turnId, prompt },
  };
  for (const listener of [...fakes.observerListeners]) listener(candidate);
}

describe('Codex TUI preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.observerListeners.clear();
    fakes.serverReady.mockResolvedValue(undefined);
    fakes.serverDispose.mockResolvedValue(undefined);
    fakes.tapReady.mockResolvedValue(undefined);
    fakes.tapDispose.mockResolvedValue(undefined);
    fakes.observerDispose.mockResolvedValue(undefined);
    fakes.spawnServer.mockReturnValue({
      process: { pid: 4242 },
      endpoint: () => ({ kind: 'unix', path: '/tmp/codex.sock' }),
      ready: fakes.serverReady,
      dispose: fakes.serverDispose,
    });
    fakes.createObserver.mockResolvedValue({
      sessionId: 'thread-1',
      observationLevel: () => 'structured',
      threadPath: () => '/tmp/thread.jsonl',
      events: { onCandidate: fakes.observerOnCandidate },
      attachThread: vi.fn(),
      onThread: fakes.observerOnThread,
      settingsUpdated: fakes.observerSettingsUpdated,
      dispose: fakes.observerDispose,
    });
  });

  it.each([false, true])('forwards briefing into the observer, never TUI argv (resume=%s)', async (resume) => {
    const briefing = {
      mcpServers: { field: { command: 'door', env: { TOKEN: 'secret' } } },
      allowTools: ['field/*'],
      instructions: 'role',
    };
    const prepared = await prepareCodexTuiSession({
      cwd: '/work',
      host: host(),
      ...(resume ? { resume: 'thread-old' } : {}),
      ...briefing,
    });
    expect(fakes.createObserver).toHaveBeenCalledWith(
      expect.objectContaining({ [resume ? 'resumeOverrides' : 'start']: expect.objectContaining(briefing) }),
    );
    expect(JSON.stringify(prepared.launch)).not.toContain('secret');
    expect(JSON.stringify(prepared.launch)).not.toContain('role');
    await prepared.dispose();
  });

  describe('naming the app-server to the host', () => {
    const paths = {
      fresh: {},
      resume: { resume: 'thread-old' },
      picker: { resumeInvocation: ['resume'] },
      imposter: { appServerEnv: { AI_PERSONA: 'codex' } },
    };

    it.each(Object.entries(paths))('names it before the thread opens (%s)', async (_path, launch) => {
      let answer!: () => void;
      const onHelperProcess = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)));
      const before = Date.now();
      const preparing = prepareCodexTuiSession({ cwd: '/work', host: host(), ingress: { onHelperProcess }, ...launch });
      await vi.waitFor(() => expect(onHelperProcess).toHaveBeenCalledOnce());
      expect(onHelperProcess).toHaveBeenCalledWith({ pid: 4242, startedAtMs: expect.any(Number) });
      const { startedAtMs } = (onHelperProcess.mock.calls[0] as unknown as [{ startedAtMs: number }])[0];
      expect(startedAtMs).toBeGreaterThanOrEqual(before);
      expect(fakes.serverReady.mock.invocationCallOrder[0]).toBeLessThan(onHelperProcess.mock.invocationCallOrder[0]!);
      // Held until the host answers: nothing that can start an MCP server has gone yet.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(fakes.createObserver).not.toHaveBeenCalled();
      answer();
      const prepared = await preparing;
      expect(fakes.createObserver).toHaveBeenCalledOnce();
      await prepared.dispose();
    });

    it('refuses the launch honestly when the hook throws, and stops the helper', async () => {
      const onHelperProcess = vi.fn(() => Promise.reject(new Error('the floor said no')));
      await expect(
        prepareCodexTuiSession({ cwd: '/work', host: host(), ingress: { onHelperProcess } }),
      ).rejects.toMatchObject({ code: 'RUN_HELPER_UNNAMED' });
      expect(fakes.createObserver).not.toHaveBeenCalled();
      expect(fakes.serverDispose).toHaveBeenCalledOnce();
    });

    it('prepares as before under a host that has no hook', async () => {
      const prepared = await prepareCodexTuiSession({ cwd: '/work', host: host(), ingress: { port: 1 } });
      expect(fakes.createObserver).toHaveBeenCalledOnce();
      await prepared.dispose();
    });
  });

  describe('the directory a briefed resume names', () => {
    const lastObserver = (): Record<string, unknown> =>
      fakes.createObserver.mock.lastCall?.[0] as Record<string, unknown>;

    it("leaves a typed resume where its thread ran, and hands the preflight the pane's directory apart", async () => {
      const prepared = await prepareCodexTuiSession({
        cwd: '/pane',
        host: host(),
        resume: 'thread-old',
        instructions: 'role',
        keepThreadCwd: true,
      });
      expect(lastObserver().resumeOverrides).toEqual(expect.objectContaining({ instructions: 'role' }));
      expect(lastObserver().resumeOverrides).not.toHaveProperty('cwd');
      expect(lastObserver().configCwd).toBe('/pane');
      await prepared.dispose();
    });

    it("moves a host's resume to the launch directory, as it always has", async () => {
      const prepared = await prepareCodexTuiSession({
        cwd: '/pane',
        host: host(),
        resume: 'thread-old',
        instructions: 'role',
      });
      expect(lastObserver().resumeOverrides).toEqual(expect.objectContaining({ cwd: '/pane' }));
      await prepared.dispose();
    });
  });

  describe('under withhold', () => {
    const conflict = { field: 'mcpServers', code: 'CONFLICTING_LAUNCH_FIELD' };

    it('takes the picker bare, and says so, where it would have refused', async () => {
      const prepared = await prepareCodexTuiSession({
        cwd: '/work',
        host: host(),
        resumeInvocation: ['resume'],
        instructions: 'role',
        briefingRefusal: 'withhold',
      });
      expect(prepared.briefingWithheld).toEqual([{ field: 'instructions', code: 'UNSUPPORTED_LAUNCH_FIELD' }]);
      expect(fakes.spawnServer).toHaveBeenCalledOnce();
      await prepared.dispose();
    });

    it('takes the imposter bare too', async () => {
      const prepared = await prepareCodexTuiSession({
        cwd: '/work',
        host: host(),
        appServerEnv: { AI_PERSONA: 'codex' },
        mcpServers: { field: { command: 'door' } },
        briefingRefusal: 'withhold',
      });
      expect(prepared.briefingWithheld).toEqual([{ field: 'mcpServers', code: 'UNSUPPORTED_LAUNCH_FIELD' }]);
      expect(fakes.createObserver.mock.lastCall?.[0]).toMatchObject({ start: { cwd: '/work' } });
      expect(fakes.createObserver.mock.lastCall?.[0].start).not.toHaveProperty('mcpServers');
      await prepared.dispose();
    });

    it('adds what the live connection withheld, on one app-server', async () => {
      fakes.createObserver.mockResolvedValue({
        sessionId: 'thread-1',
        briefingWithheld: [conflict],
        observationLevel: () => 'structured',
        threadPath: () => undefined,
        events: { onCandidate: fakes.observerOnCandidate },
        attachThread: vi.fn(),
        onThread: fakes.observerOnThread,
        settingsUpdated: fakes.observerSettingsUpdated,
        dispose: fakes.observerDispose,
      });
      const prepared = await prepareCodexTuiSession({
        cwd: '/work',
        host: host(),
        mcpServers: { field: { command: 'door' } },
        briefingRefusal: 'withhold',
      });
      expect(fakes.createObserver).toHaveBeenCalledWith(expect.objectContaining({ briefingRefusal: 'withhold' }));
      expect(prepared.briefingWithheld).toEqual([conflict]);
      expect(fakes.spawnServer).toHaveBeenCalledOnce();
      await prepared.dispose();
    });

    it('reports nothing when nothing went unapplied', async () => {
      const prepared = await prepareCodexTuiSession({ cwd: '/work', host: host(), briefingRefusal: 'withhold' });
      expect(prepared).not.toHaveProperty('briefingWithheld');
      await prepared.dispose();
    });
  });

  it('refuses a briefed resume picker before starting a helper', async () => {
    await expect(
      prepareCodexTuiSession({ cwd: '/work', host: host(), resumeInvocation: ['resume'], instructions: 'role' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_LAUNCH_FIELD' });
    expect(fakes.spawnServer).not.toHaveBeenCalled();
  });

  it('owns the thread before launch and adopts one existing terminal idempotently', async () => {
    const terminalHost = host();
    const onApproval = vi.fn(() => 'approved' as const);
    const prepared = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: terminalHost,
      model: 'gpt-test',
      effort: 'high',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      onApproval,
      env: { CODEX_HOME: '/profiles/codex', AI_PERSONA: 'codex' },
    });

    expect(terminalHost.spawnTerminal).not.toHaveBeenCalled();
    expect(prepared.sessionId).toBe('thread-1');
    expect(prepared.launch).toEqual({
      command: '/opt/codex',
      args: ['resume', 'thread-1', '--remote', 'unix:///tmp/codex-tap.sock'],
      cwd: '/work/repo',
      env: { CODEX_HOME: '/profiles/codex', AI_PERSONA: 'codex' },
    });
    expect(fakes.createObserver).toHaveBeenCalledWith(
      expect.objectContaining({
        start: expect.objectContaining({
          model: 'gpt-test',
          effort: 'high',
          sandbox: 'read-only',
          approvalPolicy: 'never',
        }),
        onApproval,
      }),
    );

    const first = await prepared.adopt('existing-pane');
    expect(first.runtimeSessionId).toBe('existing-pane');
    expect(await prepared.adopt('existing-pane')).toBe(first);
    first.events.onCandidate(() => undefined);
    expect(fakes.observerOnCandidate).toHaveBeenCalledOnce();
    await expect(prepared.adopt('other-pane')).rejects.toThrow('already adopted');

    // The thread records the input before the paste call returns.
    terminalHost.automateTerminal = vi.fn(async () => {
      threadRecords('hello', 'turn-1');
      return { accepted: true as const };
    });
    await expect(first.services.prompt.submit({ text: 'hello' })).resolves.toEqual({
      status: 'confirmed',
      turnId: 'turn-1',
    });
    expect(terminalHost.automateTerminal).toHaveBeenCalledWith('existing-pane', {
      kind: 'paste',
      text: 'hello',
      submit: true,
    });
    await prepared.dispose();
    expect(fakes.observerDispose).toHaveBeenCalledOnce();
    expect(fakes.serverDispose).toHaveBeenCalledOnce();
  });

  it("confirms a pasted prompt only on the thread's own record of it", async () => {
    const terminalHost = host();
    const session = await (await prepareCodexTuiSession({ cwd: '/work', host: terminalHost })).adopt('pane');

    // Accepted by the terminal, recorded later: confirmed with the thread's turn.
    const recorded = session.services.prompt.submit({ text: 'run the tests', confirmationTimeoutMs: 1_000 });
    await vi.waitFor(() => expect(terminalHost.automateTerminal).toHaveBeenCalledTimes(1));
    threadRecords('run the tests', 'turn-2');
    await expect(recorded).resolves.toEqual({ status: 'confirmed', turnId: 'turn-2' });

    // Someone else's input, or a draft glued to ours, is never ours: no match in time is uncertain.
    const glued = session.services.prompt.submit({ text: 'my prompt', confirmationTimeoutMs: 60 });
    await vi.waitFor(() => expect(terminalHost.automateTerminal).toHaveBeenCalledTimes(2));
    threadRecords('draft words my prompt', 'turn-3');
    await expect(glued).resolves.toMatchObject({ status: 'uncertain' });

    // A staged paste the terminal accepts asks for nothing more.
    await expect(session.services.prompt.submit({ text: 'staged', mode: 'paste-only' })).resolves.toEqual({
      status: 'confirmed',
    });

    // A refused paste stays rejected.
    terminalHost.automateTerminal = vi.fn(async () => ({ accepted: false as const, reason: 'human-input-conflict' }));
    await expect(session.services.prompt.submit({ text: 'refused' })).resolves.toEqual({
      status: 'rejected',
      reason: 'human-input-conflict',
    });
    expect(fakes.observerListeners.size).toBe(0);
  });

  it('settles a prompt still waiting for its record as uncertain when the session is disposed', async () => {
    const prepared = await prepareCodexTuiSession({ cwd: '/work', host: host() });
    const session = await prepared.adopt('pane');
    const waiting = session.services.prompt.submit({ text: 'hello', confirmationTimeoutMs: 60_000 });
    await vi.waitFor(() => expect(fakes.observerListeners.size).toBe(1));
    await prepared.dispose();
    await expect(waiting).resolves.toMatchObject({ status: 'uncertain' });
  });

  it("resumes a thread at the chosen model and effort through the observer's first thread/resume", async () => {
    const prepared = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: host(),
      resume: 'thread-1',
      model: 'gpt-test',
      effort: 'high',
    });
    expect(fakes.createObserver).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: 'thread-1', resumeOverrides: { model: 'gpt-test', effort: 'high' } }),
    );
    expect(fakes.createObserver.mock.lastCall?.[0]).not.toHaveProperty('start');
    // The TUI joins the thread the observer resumed, and adopts its settings (C7).
    expect(prepared.launch.args).toEqual(['resume', 'thread-1', '--remote', 'unix:///tmp/codex-tap.sock']);
    await prepared.dispose();

    const inherited = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: host(),
      resume: 'thread-1',
    });
    expect(fakes.createObserver.mock.lastCall?.[0]).not.toHaveProperty('resumeOverrides');
    await inherited.dispose();
  });

  it('preserves the managed createSession spawn path through the same preparation', async () => {
    const terminalHost = host();
    const session = await createCodexTuiSession({ cwd: '/work/repo', host: terminalHost, executable: 'codex' });

    expect(terminalHost.spawnTerminal).toHaveBeenCalledWith({
      command: 'codex',
      args: ['resume', 'thread-1', '--remote', 'unix:///tmp/codex-tap.sock'],
      cwd: '/work/repo',
    });
    expect(session.runtimeSessionId).toBe('spawned-pane');
    await session.dispose();
  });

  it("lets a typed launch's unset permissions come from the configuration, and a host's spawn keep the defaults", async () => {
    const startOf = (call: number): { permissionDefaults?: unknown } =>
      (fakes.createObserver.mock.calls[call]![0] as { start: { permissionDefaults?: unknown } }).start;

    const typed = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: host(),
      permissionDefaults: 'configuration',
    });
    expect(startOf(0)).toEqual({ cwd: '/work/repo', permissionDefaults: 'configuration' });
    await typed.dispose();

    const spawned = await createCodexTuiSession({ cwd: '/work/repo', host: host(), executable: 'codex' });
    expect(startOf(1).permissionDefaults).toBeUndefined();
    await spawned.dispose();
  });

  it("carries typed arguments after the adapter's --remote, the prompt last, and settings to the server", async () => {
    const prepared = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: host(),
      appServerArguments: ['--config=web_search=live', '--disable=goals'],
      tuiArguments: ['--image=/work/a.png', '--image=/work/b.png', '--search', '--no-alt-screen'],
      prompt: '-v is broken',
    });

    const args = prepared.launch.args;
    expect(args).toEqual([
      'resume',
      'thread-1',
      '--remote',
      'unix:///tmp/codex-tap.sock',
      '--image=/work/a.png',
      '--image=/work/b.png',
      '--search',
      '--no-alt-screen',
      '--',
      '-v is broken',
    ]);
    // Said once: one --remote, and its value is the adapter's address, never the prompt.
    expect(args.filter((argument) => argument === '--remote')).toHaveLength(1);
    expect(args[args.indexOf('--remote') + 1]).toBe('unix:///tmp/codex-tap.sock');
    // A carried variadic follows the address, and the prompt follows `--`: neither can be swallowed.
    expect(args.findIndex((argument) => argument.startsWith('--image'))).toBeGreaterThan(args.indexOf('--remote') + 1);
    expect(args.slice(-2)).toEqual(['--', '-v is broken']);
    expect(fakes.spawnServer).toHaveBeenCalledWith({
      executable: '/opt/codex',
      args: ['--config=web_search=live', '--disable=goals'],
    });
    await prepared.dispose();
  });

  it('carries TUI arguments after the picker, and starts the server with no arguments when none were typed', async () => {
    fakes.createObserver.mockResolvedValue({
      sessionId: undefined,
      observationLevel: () => 'structured',
      threadPath: () => undefined,
      events: { onCandidate: fakes.observerOnCandidate },
      attachThread: vi.fn(),
      onThread: fakes.observerOnThread,
      settingsUpdated: fakes.observerSettingsUpdated,
      dispose: fakes.observerDispose,
    });
    const prepared = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: host(),
      resumeInvocation: ['resume', '--last'],
      tuiArguments: ['--no-alt-screen'],
    });
    expect(prepared.launch.args).toEqual([
      'resume',
      '--last',
      '--remote',
      'unix:///tmp/codex-tap.sock',
      '--no-alt-screen',
    ]);
    expect(fakes.spawnServer).toHaveBeenCalledWith({ executable: '/opt/codex' });
    await prepared.dispose();
  });

  it("runs the private app-server under the host's helper environment when the host composes one", async () => {
    const helperEnvironment = vi.fn((env: Record<string, string>) => ({ PATH: '/agent/bin', ...env }));
    const prepared = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: { ...host(), helperEnvironment },
      appServerEnv: { CODEX_HOME: '/profiles/work' },
    });
    // the adapter's own variables go through the host's policy, and nothing of this process's is merged back
    expect(helperEnvironment).toHaveBeenCalledWith({ CODEX_HOME: '/profiles/work' });
    expect(fakes.spawnServer).toHaveBeenCalledWith({
      executable: '/opt/codex',
      env: { PATH: '/agent/bin', CODEX_HOME: '/profiles/work' },
      inheritEnvironment: false,
    });
    await prepared.dispose();
  });

  it('refuses a recipe clap would misread before it starts anything', async () => {
    const base = { cwd: '/work/repo', executable: '/opt/codex', host: host() };
    await expect(
      prepareCodexTuiSession({ ...base, resumeInvocation: ['resume', '--last'], prompt: 'go on' }),
    ).rejects.toThrow('carries a prompt only into a thread it owns');
    for (const tuiArguments of [
      ['--remote', 'ws://127.0.0.1:1'],
      ['--remote=ws://127.0.0.1:1'],
      ['--'],
      ['--remote-auth-token-env=T'],
    ]) {
      await expect(prepareCodexTuiSession({ ...base, tuiArguments })).rejects.toThrow(
        'must not carry the remote transport',
      );
    }
    await expect(
      prepareCodexTuiSession({ ...base, appServerArguments: ['--listen=ws://127.0.0.1:1'] }),
    ).rejects.toThrow('must not carry the listener');
    expect(fakes.spawnServer).not.toHaveBeenCalled();
  });

  it('preserves the native resume picker and binds its selected thread lazily', async () => {
    let selectedThread: string | undefined;
    const attachThread = vi.fn(async (threadId: string) => {
      selectedThread = threadId;
    });
    fakes.createObserver.mockResolvedValue({
      get sessionId() {
        return selectedThread;
      },
      observationLevel: () => 'structured',
      threadPath: () => undefined,
      events: { onCandidate: fakes.observerOnCandidate },
      attachThread,
      onThread: fakes.observerOnThread,
      settingsUpdated: fakes.observerSettingsUpdated,
      dispose: fakes.observerDispose,
    });
    const prepared = await prepareCodexTuiSession({
      cwd: '/work/repo',
      executable: '/opt/codex',
      host: host(),
      resumeInvocation: ['resume'],
    });

    expect(prepared.sessionId).toMatch(/^codex-pending-/);
    expect(prepared.launch.args).toEqual(['resume', '--remote', 'unix:///tmp/codex-tap.sock']);
    expect(fakes.createObserver).toHaveBeenCalledWith(
      expect.not.objectContaining({ start: expect.anything(), threadId: expect.anything() }),
    );
    const session = await prepared.adopt('existing-pane');
    expect(session.sessionId).toBe(prepared.sessionId);
    fakes.tapClientMessage?.({ method: 'thread/resume', params: { threadId: 'thread-selected-in-picker' } });
    await vi.waitFor(() => expect(attachThread).toHaveBeenCalledWith('thread-selected-in-picker'));
    expect(session.sessionId).toBe('thread-selected-in-picker');
    await session.dispose();
    expect(fakes.tapDispose).toHaveBeenCalledOnce();
  });

  it('handles a picked thread Codex refuses, leaving the diagnostic to the observer', async () => {
    // findings C9: the observer publishes the refusal, then rejects the attach nobody awaits.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    // A plain function: a mock records its settled result, which would handle the rejection itself.
    const attached: string[] = [];
    const attachThread = (threadId: string): Promise<void> => {
      attached.push(threadId);
      return Promise.reject(new Error('refused for its model provider'));
    };
    fakes.createObserver.mockResolvedValue({
      sessionId: undefined,
      observationLevel: () => 'structured',
      threadPath: () => undefined,
      events: { onCandidate: fakes.observerOnCandidate },
      attachThread,
      onThread: fakes.observerOnThread,
      settingsUpdated: fakes.observerSettingsUpdated,
      dispose: fakes.observerDispose,
    });
    try {
      const prepared = await prepareCodexTuiSession({
        cwd: '/work/repo',
        executable: '/opt/codex',
        host: host(),
        resumeInvocation: ['resume'],
      });
      fakes.tapClientMessage?.({ method: 'thread/resume', params: { threadId: 'thread-refused' } });
      expect(attached).toEqual(['thread-refused']);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
      await prepared.dispose();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  describe('the thread the TUI moves to', () => {
    /** An observer whose thread a test sets, as the real one does once it attaches. */
    function movingObserver(initial: string | undefined) {
      let observed = initial;
      const attachThread = vi.fn(async (threadId: string) => {
        observed = threadId;
      });
      const followThread = vi.fn(async (_thread: { id: string }, _move: string) => undefined);
      fakes.createObserver.mockResolvedValue({
        get sessionId() {
          return observed;
        },
        observationLevel: () => 'structured',
        threadPath: () => undefined,
        events: { onCandidate: fakes.observerOnCandidate },
        attachThread,
        followThread,
        onThread: fakes.observerOnThread,
        settingsUpdated: fakes.observerSettingsUpdated,
        dispose: fakes.observerDispose,
      });
      return { attachThread, followThread, observe: (threadId: string) => (observed = threadId) };
    }

    it('joins every TUI through the tap, and hands the observer the thread each start, resume or fork names', async () => {
      const { attachThread, followThread } = movingObserver('thread-1');
      const prepared = await prepareCodexTuiSession({ cwd: '/work', host: host() });
      const reader = fakes.tapServerReader!;
      expect(reader).toBeDefined();
      // nothing waits: the answers of an ordinary turn are not even parsed
      expect(reader.waiting()).toBe(false);
      // the TUI's own resume of the thread this recipe owns: its answer names the thread observed
      fakes.tapClientMessage!({ id: 1, method: 'thread/resume', params: { threadId: 'thread-1' } });
      reader.message({ id: 1, result: { thread: { id: 'thread-1' } } });
      // `/new`: the request carries no id, the answer does
      fakes.tapClientMessage!({ id: 7, method: 'thread/start', params: { cwd: '/work' } });
      expect(reader.waiting()).toBe(true);
      reader.message({ id: 7, result: { thread: { id: 'thread-new', name: null } } });
      expect(reader.waiting()).toBe(false);
      // a resume and a fork, answered out of order, under ids of either kind
      fakes.tapClientMessage!({ id: 'r-1', method: 'thread/resume', params: { threadId: 'thread-old' } });
      fakes.tapClientMessage!({ id: 8, method: 'thread/fork', params: { threadId: 'thread-new' } });
      reader.message({ jsonrpc: '2.0', id: 8, result: { thread: { id: 'thread-fork', forkedFromId: 'thread-new' } } });
      reader.message({ jsonrpc: '2.0', id: 'r-1', result: { thread: { id: 'thread-old' } } });
      expect(followThread.mock.calls.map(([thread, move]) => [thread.id, move])).toEqual([
        ['thread-1', 'resume'],
        ['thread-new', 'new'],
        ['thread-fork', 'fork'],
        ['thread-old', 'resume'],
      ]);
      expect(followThread.mock.calls[1]![0]).toEqual({ id: 'thread-new', name: null });
      // a thread this recipe owns is attached already: no request attaches one
      expect(attachThread).not.toHaveBeenCalled();
      await prepared.dispose();
      expect(fakes.tapDispose).toHaveBeenCalledOnce();
    });

    it('drops a request answered with an error, reads no other answer, and forgets the oldest of many', async () => {
      const { followThread } = movingObserver('thread-1');
      const prepared = await prepareCodexTuiSession({ cwd: '/work', host: host() });
      const reader = fakes.tapServerReader!;
      fakes.tapClientMessage!({ id: 9, method: 'thread/start', params: {} });
      reader.message({ id: 9, error: { code: -32600, message: 'refused' } });
      expect(reader.waiting()).toBe(false);
      // a request that names no thread is not kept
      fakes.tapClientMessage!({ id: 10, method: 'turn/start', params: { threadId: 'thread-1' } });
      fakes.tapClientMessage!({ method: 'thread/start', params: {} });
      expect(reader.waiting()).toBe(false);
      fakes.tapClientMessage!({ id: 11, method: 'thread/start', params: {} });
      // a notification, a server request, another request's answer, and an answer with no thread
      reader.message({ method: 'thread/started', params: { thread: { id: 'thread-x' } } });
      reader.message({ id: 11, method: 'item/commandExecution/requestApproval', params: {} });
      reader.message({ id: 12, result: { thread: { id: 'thread-y' } } });
      reader.message({ id: 11, result: {} });
      expect(followThread).not.toHaveBeenCalled();
      expect(reader.waiting()).toBe(false);
      for (let n = 0; n < 40; n++) {
        fakes.tapClientMessage!({ id: 100 + n, method: 'thread/resume', params: { threadId: `thread-${n}` } });
      }
      reader.message({ id: 100, result: { thread: { id: 'thread-forgotten' } } });
      reader.message({ id: 139, result: { thread: { id: 'thread-kept' } } });
      expect(followThread.mock.calls.map(([thread]) => thread.id)).toEqual(['thread-kept']);
      await prepared.dispose();
    });

    it('keeps a picker provisional until the TUI resumes the chosen thread: listing and reading threads choose none', async () => {
      const { attachThread } = movingObserver(undefined);
      const prepared = await prepareCodexTuiSession({ cwd: '/work', host: host(), resumeInvocation: ['resume'] });
      const session = await prepared.adopt('pane');
      expect(session.nativeSessionProvisional?.()).toBe(true);
      expect(session.sessionId).toMatch(/^codex-pending-/);
      // what a picker asks to list and show threads names no choice
      fakes.tapClientMessage!({ id: 1, method: 'thread/list', params: {} });
      fakes.tapClientMessage!({ id: 2, method: 'thread/read', params: { threadId: 'thread-a' } });
      fakes.tapClientMessage!({ id: 3, method: 'thread/turns/list', params: { threadId: 'thread-a' } });
      expect(session.nativeSessionProvisional?.()).toBe(true);
      expect(attachThread).not.toHaveBeenCalled();
      expect(fakes.tapServerReader!.waiting()).toBe(false);
      // the choice: the observer attaches it from the request, before the thread's start is published
      fakes.tapClientMessage!({ id: 4, method: 'thread/resume', params: { threadId: 'thread-a' } });
      expect(attachThread).toHaveBeenCalledExactlyOnceWith('thread-a');
      await vi.waitFor(() => expect(session.nativeSessionProvisional?.()).toBe(false));
      expect(session.sessionId).toBe('thread-a');
      await session.dispose();
    });

    it('is never provisional for a thread the recipe owns or resumed by id', async () => {
      movingObserver('thread-1');
      const fresh = await (await prepareCodexTuiSession({ cwd: '/work', host: host() })).adopt('pane');
      expect(fresh.nativeSessionProvisional?.()).toBe(false);
      await fresh.dispose();
      const resumed = await (
        await prepareCodexTuiSession({ cwd: '/work', host: host(), resume: 'thread-1' })
      ).adopt('pane');
      expect(resumed.nativeSessionProvisional?.()).toBe(false);
      await resumed.dispose();
    });
  });

  describe('the model switch', () => {
    /** A connection that answers every request with `{}`, and can speak as the app-server. */
    function settingsConnection() {
      const sent: { id?: number; method?: string; params?: Record<string, unknown> }[] = [];
      let deliver: (message: unknown) => void = () => undefined;
      const close = vi.fn();
      Object.assign(fakes.transport, {
        send(message: { id?: number; method?: string; params?: Record<string, unknown> }) {
          sent.push(message);
          if (message.id !== undefined) queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id, result: {} }));
        },
        onMessage(handler: (message: unknown) => void) {
          deliver = handler;
        },
        onClose: () => undefined,
        close,
      });
      return { sent, close, say: (message: unknown) => deliver(message) };
    }
    const settled = () => new Promise((resolve) => setTimeout(resolve, 5));

    it('listens on a connection of its own to the app-server from adoption, and hands the observer what it hears', async () => {
      const connection = settingsConnection();
      try {
        const prepared = await prepareCodexTuiSession({ cwd: '/work/repo', executable: '/opt/codex', host: host() });
        expect(connection.sent).toEqual([]);
        const session = await prepared.adopt('pane');
        await settled();
        expect(session.services.modelSwitch?.offer).toEqual({
          model: true,
          controls: ['effort'],
          persistence: 'session',
        });
        expect(connection.sent.map(({ method }) => method)).toEqual(['initialize', 'initialized', 'thread/resume']);
        expect(connection.sent[2]!.params).toEqual({ threadId: 'thread-1', excludeTurns: true });

        const settings = { threadId: 'thread-1', threadSettings: { model: 'gpt-test', effort: 'low' } };
        connection.say({ jsonrpc: '2.0', method: 'thread/settings/updated', params: settings });
        expect(fakes.observerSettingsUpdated).toHaveBeenCalledExactlyOnceWith(settings);

        await expect(session.services.modelSwitch!.submit({ kind: 'model', modelId: 'gpt-other' })).resolves.toEqual({
          status: 'sent',
        });
        expect(connection.sent.at(-1)).toMatchObject({
          method: 'thread/settings/update',
          params: { threadId: 'thread-1', model: 'gpt-other' },
        });

        await session.dispose();
        expect(connection.close).toHaveBeenCalledOnce();
        expect(fakes.observerDispose).toHaveBeenCalledOnce();
      } finally {
        for (const key of Object.keys(fakes.transport)) delete (fakes.transport as Record<string, unknown>)[key];
      }
    });

    it("waits for a picker's thread before it listens", async () => {
      const connection = settingsConnection();
      let selectedThread: string | undefined;
      fakes.createObserver.mockResolvedValue({
        get sessionId() {
          return selectedThread;
        },
        observationLevel: () => 'structured',
        threadPath: () => undefined,
        events: { onCandidate: fakes.observerOnCandidate },
        attachThread: vi.fn(),
        onThread: fakes.observerOnThread,
        settingsUpdated: fakes.observerSettingsUpdated,
        dispose: fakes.observerDispose,
      });
      try {
        const prepared = await prepareCodexTuiSession({
          cwd: '/work/repo',
          executable: '/opt/codex',
          host: host(),
          resumeInvocation: ['resume'],
        });
        await prepared.adopt('pane');
        await settled();
        expect(connection.sent).toEqual([]);

        selectedThread = 'thread-picked';
        fakes.observerOnThread.mock.lastCall![0]({ threadId: 'thread-picked' });
        await settled();
        expect(connection.sent.map(({ method }) => method)).toEqual(['initialize', 'initialized', 'thread/resume']);
        expect(connection.sent[2]!.params).toEqual({ threadId: 'thread-picked', excludeTurns: true });
        await prepared.dispose();
      } finally {
        for (const key of Object.keys(fakes.transport)) delete (fakes.transport as Record<string, unknown>)[key];
      }
    });

    it('listens to the thread the TUI moved to, on the connection it already has', async () => {
      const connection = settingsConnection();
      let observed = 'thread-1';
      fakes.createObserver.mockResolvedValue({
        get sessionId() {
          return observed;
        },
        observationLevel: () => 'structured',
        threadPath: () => undefined,
        events: { onCandidate: fakes.observerOnCandidate },
        attachThread: vi.fn(),
        followThread: vi.fn(),
        onThread: fakes.observerOnThread,
        settingsUpdated: fakes.observerSettingsUpdated,
        dispose: fakes.observerDispose,
      });
      try {
        const prepared = await prepareCodexTuiSession({ cwd: '/work/repo', executable: '/opt/codex', host: host() });
        await prepared.adopt('pane');
        await settled();
        observed = 'thread-2';
        fakes.observerOnThread.mock.lastCall![0]({ threadId: 'thread-2' });
        await settled();
        expect(connection.sent.map(({ method, params }) => [method, params?.threadId])).toEqual([
          ['initialize', undefined],
          ['initialized', undefined],
          ['thread/resume', 'thread-1'],
          ['thread/resume', 'thread-2'],
        ]);
        await prepared.dispose();
        expect(connection.close).toHaveBeenCalledOnce();
      } finally {
        for (const key of Object.keys(fakes.transport)) delete (fakes.transport as Record<string, unknown>)[key];
      }
    });

    it('leaves the session whole when the connection cannot be made', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        // The suite's bare transport: nothing can be sent on it.
        const prepared = await prepareCodexTuiSession({ cwd: '/work/repo', executable: '/opt/codex', host: host() });
        const session = await prepared.adopt('pane');
        await settled();
        expect(unhandled).not.toHaveBeenCalled();
        const receipt = await session.services.modelSwitch!.submit({ kind: 'model', modelId: 'gpt-other' });
        expect(receipt.status).toBe('rejected');
        await session.dispose();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });
});
