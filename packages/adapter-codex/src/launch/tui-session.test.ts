import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';

const fakes = vi.hoisted(() => ({
  createObserver: vi.fn(),
  observerOnCandidate: vi.fn(() => () => undefined),
  observerDispose: vi.fn(),
  serverDispose: vi.fn(),
  serverReady: vi.fn(),
  spawnServer: vi.fn(),
  transport: {},
  tapReady: vi.fn(),
  tapDispose: vi.fn(),
  tapClientMessage: undefined as ((message: unknown) => void) | undefined,
}));

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
    (_upstream: { kind: string; path?: string; url?: string }, onClientMessage: (message: unknown) => void) => {
      fakes.tapClientMessage = onClientMessage;
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

describe('Codex TUI preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.serverReady.mockResolvedValue(undefined);
    fakes.serverDispose.mockResolvedValue(undefined);
    fakes.tapReady.mockResolvedValue(undefined);
    fakes.tapDispose.mockResolvedValue(undefined);
    fakes.observerDispose.mockResolvedValue(undefined);
    fakes.spawnServer.mockReturnValue({
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
      args: ['resume', 'thread-1', '--remote', 'unix:///tmp/codex.sock'],
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

    await first.services.prompt.submit({ text: 'hello' });
    expect(terminalHost.automateTerminal).toHaveBeenCalledWith('existing-pane', {
      kind: 'paste',
      text: 'hello',
      submit: true,
    });
    await prepared.dispose();
    expect(fakes.observerDispose).toHaveBeenCalledOnce();
    expect(fakes.serverDispose).toHaveBeenCalledOnce();
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
    expect(prepared.launch.args).toEqual(['resume', 'thread-1', '--remote', 'unix:///tmp/codex.sock']);
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
      args: ['resume', 'thread-1', '--remote', 'unix:///tmp/codex.sock'],
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
      'unix:///tmp/codex.sock',
      '--image=/work/a.png',
      '--image=/work/b.png',
      '--search',
      '--no-alt-screen',
      '--',
      '-v is broken',
    ]);
    // Said once: one --remote, and its value is the adapter's address, never the prompt.
    expect(args.filter((argument) => argument === '--remote')).toHaveLength(1);
    expect(args[args.indexOf('--remote') + 1]).toBe('unix:///tmp/codex.sock');
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
});
