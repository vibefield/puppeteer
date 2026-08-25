import { once } from 'node:events';
import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { unknownSessionActivity, type SessionSummary } from '@vibecook/ghosttea-protocol';
import {
  matchingTerminalSession,
  parseSpawnThroughInvocation,
  prepareSpawnThroughLaunch,
  startSpawnThroughGateway,
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

describe('Godview spawn-through', () => {
  it('closes promptly even when a client leaves an incomplete request open', async () => {
    const gateway = await startSpawnThroughGateway('secret', async () => ({ action: 'ack' }));
    const socket = connect(gateway.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('{"token":"secret"');
    // destroy() may surface ECONNRESET before close; reset is the expected
    // transport outcome, while the assertion is that gateway.close resolves.
    socket.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

    await expect(gateway.close()).resolves.toBeUndefined();
    await closed;
  });

  it('maps explicit and native resume forms for every built-in CLI', () => {
    const id = '64a61b19-f4d8-4f96-ba56-07024b470813';
    expect(parseSpawnThroughInvocation('claude', ['--resume', id])).toEqual({ resume: id });
    expect(parseSpawnThroughInvocation('claude', ['--resume'])).toEqual({
      agentOptions: { resumeInvocation: ['--resume'] },
    });
    expect(parseSpawnThroughInvocation('claude', ['--continue'])).toEqual({
      agentOptions: { resumeInvocation: ['--continue'] },
    });
    expect(
      parseSpawnThroughInvocation('claude', [
        '--model',
        'haiku',
        '--effort',
        'low',
        '--permission-mode',
        'plan',
        '--setting-sources',
        'project,local',
      ]),
    ).toEqual({
      agentOptions: {
        model: 'haiku',
        effort: 'low',
        permissionMode: 'plan',
        settingSources: ['project', 'local'],
      },
    });
    expect(parseSpawnThroughInvocation('claude', ['--continue', '--model', 'sonnet'])).toEqual({
      agentOptions: { model: 'sonnet', resumeInvocation: ['--continue'] },
    });
    expect(parseSpawnThroughInvocation('claude', ['--model'])).toEqual({
      error: 'custom arguments are not spawn-through compatible',
    });
    expect(parseSpawnThroughInvocation('claude', ['--setting-sources', 'project,managed'])).toEqual({
      error: 'custom arguments are not spawn-through compatible',
    });
    expect(parseSpawnThroughInvocation('codex', ['resume', id])).toEqual({ resume: id });
    expect(parseSpawnThroughInvocation('codex', ['resume'])).toEqual({
      agentOptions: { resumeInvocation: ['resume'] },
    });
    expect(parseSpawnThroughInvocation('codex', ['resume', '--last'])).toEqual({
      agentOptions: { resumeInvocation: ['resume', '--last'] },
    });
    expect(parseSpawnThroughInvocation('grok', ['--resume', id])).toEqual({ resume: id });
    expect(parseSpawnThroughInvocation('grok', ['--resume'])).toEqual({
      agentOptions: { resumeLatest: true },
    });
    expect(parseSpawnThroughInvocation('grok', ['--continue'])).toEqual({
      agentOptions: { resumeLatest: true },
    });
    expect(parseSpawnThroughInvocation('kimi', ['--session', 'session_a11a5ed0e3893bf87803ae0292ed383a0834'])).toEqual({
      resume: 'session_a11a5ed0e3893bf87803ae0292ed383a0834',
    });
    expect(parseSpawnThroughInvocation('kimi', ['-S', 'session_a11a5ed0e3893bf87803ae0292ed383a0834'])).toEqual({
      resume: 'session_a11a5ed0e3893bf87803ae0292ed383a0834',
    });
    expect(parseSpawnThroughInvocation('kimi', ['--session', '..'])).toEqual({
      error: 'custom arguments are not spawn-through compatible',
    });
    expect(parseSpawnThroughInvocation('opencode', ['--session', 'ses_a11a5ed0'])).toEqual({
      resume: 'ses_a11a5ed0',
    });
    expect(parseSpawnThroughInvocation('opencode', ['-s', 'ses_a11a5ed0'])).toEqual({
      resume: 'ses_a11a5ed0',
    });
    expect(parseSpawnThroughInvocation('opencode', ['--continue'])).toEqual({
      error: 'custom arguments are not spawn-through compatible',
    });
  });

  it('matches a direct shell child and the shell-exec optimization', () => {
    expect(matchingTerminalSession([shellSession], { pid: 456, parentPid: 123 })?.id).toBe('terminal-1');
    expect(matchingTerminalSession([shellSession], { pid: 123, parentPid: 9 })?.id).toBe('terminal-1');
  });

  it('prepares and adopts the existing terminal before returning the authoritative recipe', async () => {
    const prepareSession = vi.fn().mockResolvedValue({
      preparationId: 'preparation-1',
      agent: 'codex',
      sessionId: 'thread-1',
      launch: { command: '/real/codex', args: ['resume', 'thread-1'], cwd: '/repo' },
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    const adoptPrepared = vi.fn().mockResolvedValue({
      preparationId: 'preparation-1',
      agent: 'codex',
      sessionId: 'thread-1',
      runtimeSessionId: 'terminal-1',
      processId: 456,
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
    });
    const onAdopted = vi.fn();
    const result = await prepareSpawnThroughLaunch(
      { type: 'launch', token: 'secret', agent: 'codex', cwd: '/repo', argv: [], pid: 456, parentPid: 123 },
      {
        runtime: { prepareSession, adoptPrepared, cancelPrepared: vi.fn() } as never,
        listSessions: async () => [shellSession],
        onAdopted,
      },
    );

    expect(prepareSession).toHaveBeenCalledWith({ agent: 'codex', cwd: '/repo' });
    expect(adoptPrepared).toHaveBeenCalledWith('preparation-1', {
      runtimeSessionId: 'terminal-1',
      processId: 456,
    });
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(result).toEqual({
      action: 'exec',
      preparationId: 'preparation-1',
      launch: { command: '/real/codex', args: ['resume', 'thread-1'], cwd: '/repo' },
    });
  });

  it('passes a native resume selection through preparation and adoption', async () => {
    const prepared = {
      preparationId: 'preparation-1',
      agent: 'codex',
      sessionId: 'codex-pending-1',
      launch: { command: '/real/codex', args: ['resume', '--last', '--remote', 'unix:///tmp/tap.sock'], cwd: '/repo' },
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const prepareSession = vi.fn().mockResolvedValue(prepared);
    const adoptPrepared = vi.fn().mockResolvedValue({
      preparationId: 'preparation-1',
      agent: 'codex',
      sessionId: 'codex-pending-1',
      runtimeSessionId: 'terminal-1',
      processId: 456,
      workspace: prepared.workspace,
    });

    const result = await prepareSpawnThroughLaunch(
      {
        type: 'launch',
        token: 'secret',
        agent: 'codex',
        cwd: '/repo',
        argv: ['resume', '--last'],
        pid: 456,
        parentPid: 123,
      },
      {
        runtime: { prepareSession, adoptPrepared, cancelPrepared: vi.fn() } as never,
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );

    expect(prepareSession).toHaveBeenCalledWith({
      agent: 'codex',
      cwd: '/repo',
      agentOptions: { resumeInvocation: ['resume', '--last'] },
    });
    expect(adoptPrepared).toHaveBeenCalledOnce();
    expect(result).toEqual({ action: 'exec', preparationId: 'preparation-1', launch: prepared.launch });
  });

  it('binds an `ai --claude` pane to the imposter, and only that pane', async () => {
    const prepared = {
      preparationId: 'preparation-1',
      agent: 'claude',
      sessionId: 'claude-1',
      launch: {
        command: '/usr/bin/node',
        args: ['/opt/ai', '--settings', '/tmp/s.json'],
        cwd: '/repo',
        env: { A: '1' },
      },
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const prepareSession = vi.fn().mockResolvedValue(prepared);
    const result = await prepareSpawnThroughLaunch(
      {
        type: 'launch',
        token: 'secret',
        agent: 'claude',
        cwd: '/repo',
        argv: [],
        pid: 456,
        parentPid: 123,
        imposter: true,
      },
      {
        runtime: {
          prepareSession,
          adoptPrepared: vi.fn().mockResolvedValue({ ...prepared, runtimeSessionId: 'terminal-1', processId: 456 }),
          cancelPrepared: vi.fn(),
        } as never,
        imposterBin: () => '/opt/ai',
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );

    // Per session, not per process: the executable rides in agentOptions, so
    // every other pane still launches the user's real Claude Code.
    //
    // Claude needs no cooperating backend, so the final launch merge below is
    // the part that carries the persona into its terminal process.
    expect(prepareSession).toHaveBeenCalledWith({
      agent: 'claude',
      cwd: '/repo',
      agentOptions: { executable: '/opt/ai', appServerEnv: { AI_PERSONA: 'claude' } },
    });
    // The adapter owns argv, so the persona has to arrive in the environment —
    // and the rest of the recipe's env has to survive that.
    expect(result).toMatchObject({
      action: 'exec',
      launch: { env: { A: '1', AI_PERSONA: 'claude' } },
    });
  });

  it('lets an `ai --grok` pane through after the full leader/ACP/log recipe passes conformance', async () => {
    const prepared = {
      preparationId: 'preparation-grok',
      agent: 'grok',
      sessionId: 'grok-1',
      launch: {
        command: '/opt/ai',
        args: ['--leader', '--leader-socket', '/tmp/g.sock', '--resume', 'grok-1'],
        cwd: '/repo',
        env: { GROK_HOME: '/tmp/grok-home', CHOPSTICKS_IMPOSTER_HOME: '/tmp/grok-home' },
      },
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const prepareSession = vi.fn().mockResolvedValue(prepared);
    const result = await prepareSpawnThroughLaunch(
      {
        type: 'launch',
        token: 'secret',
        agent: 'grok',
        cwd: '/repo',
        argv: [],
        pid: 456,
        parentPid: 123,
        imposter: true,
      },
      {
        runtime: {
          prepareSession,
          adoptPrepared: vi.fn().mockResolvedValue({ ...prepared, runtimeSessionId: 'terminal-1', processId: 456 }),
          cancelPrepared: vi.fn(),
        } as never,
        imposterBin: () => '/opt/ai',
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );

    expect(prepareSession).toHaveBeenCalledWith({
      agent: 'grok',
      cwd: '/repo',
      agentOptions: { executable: '/opt/ai', appServerEnv: { AI_PERSONA: 'grok' } },
    });
    expect(result).toMatchObject({
      action: 'exec',
      launch: {
        env: { AI_PERSONA: 'grok', GROK_HOME: '/tmp/grok-home', CHOPSTICKS_IMPOSTER_HOME: '/tmp/grok-home' },
      },
    });
  });

  it('binds `ai --kimi` to one isolated durable store shared with the observer', async () => {
    const home = '/tmp/godview-kimi-imposter';
    const prepared = {
      preparationId: 'preparation-kimi',
      agent: 'kimi',
      sessionId: 'kimi-pending-1',
      launch: {
        command: '/opt/ai',
        args: [],
        cwd: '/repo',
        env: {
          AI_PERSONA: 'kimi',
          KIMI_CODE_HOME: home,
          CHOPSTICKS_IMPOSTER_HOME: home,
        },
      },
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const prepareSession = vi.fn().mockResolvedValue(prepared);
    const result = await prepareSpawnThroughLaunch(
      {
        type: 'launch',
        token: 'secret',
        agent: 'kimi',
        cwd: '/repo',
        argv: [],
        pid: 456,
        parentPid: 123,
        imposter: true,
      },
      {
        runtime: {
          prepareSession,
          adoptPrepared: vi.fn().mockResolvedValue({ ...prepared, runtimeSessionId: 'terminal-1', processId: 456 }),
          cancelPrepared: vi.fn(),
        } as never,
        imposterBin: () => '/opt/ai',
        imposterHome: () => home,
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );

    expect(prepareSession).toHaveBeenCalledWith({
      agent: 'kimi',
      cwd: '/repo',
      agentOptions: {
        executable: '/opt/ai',
        kimiHome: home,
        env: {
          AI_PERSONA: 'kimi',
          KIMI_CODE_HOME: home,
          CHOPSTICKS_IMPOSTER_HOME: home,
        },
      },
    });
    expect(result).toMatchObject({
      action: 'exec',
      launch: {
        env: {
          AI_PERSONA: 'kimi',
          KIMI_CODE_HOME: home,
          CHOPSTICKS_IMPOSTER_HOME: home,
        },
      },
    });
  });

  it('binds `ai --opencode` to one isolated store shared by its private backend and exact attach', async () => {
    const home = '/tmp/godview-opencode-imposter';
    const prepared = {
      preparationId: 'preparation-opencode',
      agent: 'opencode',
      sessionId: 'ses_a11a5ed0',
      launch: {
        command: '/opt/ai',
        args: ['attach', 'http://127.0.0.1:43210', '--dir', '/repo', '--session', 'ses_a11a5ed0', '--pure'],
        cwd: '/repo',
        env: {
          AI_PERSONA: 'opencode',
          CHOPSTICKS_IMPOSTER_HOME: home,
          OPENCODE_SERVER_USERNAME: 'opencode',
          OPENCODE_SERVER_PASSWORD: 'private-secret',
        },
      },
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const prepareSession = vi.fn().mockResolvedValue(prepared);
    const result = await prepareSpawnThroughLaunch(
      {
        type: 'launch',
        token: 'secret',
        agent: 'opencode',
        cwd: '/repo',
        argv: [],
        pid: 456,
        parentPid: 123,
        imposter: true,
      },
      {
        runtime: {
          prepareSession,
          adoptPrepared: vi.fn().mockResolvedValue({ ...prepared, runtimeSessionId: 'terminal-1', processId: 456 }),
          cancelPrepared: vi.fn(),
        } as never,
        imposterBin: () => '/opt/ai',
        imposterHome: () => home,
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );

    expect(prepareSession).toHaveBeenCalledWith({
      agent: 'opencode',
      cwd: '/repo',
      agentOptions: {
        executable: '/opt/ai',
        env: {
          AI_PERSONA: 'opencode',
          CHOPSTICKS_IMPOSTER_HOME: home,
        },
      },
    });
    expect(result).toMatchObject({
      action: 'exec',
      launch: {
        args: ['attach', 'http://127.0.0.1:43210', '--dir', '/repo', '--session', 'ses_a11a5ed0', '--pure'],
        env: {
          AI_PERSONA: 'opencode',
          CHOPSTICKS_IMPOSTER_HOME: home,
          OPENCODE_SERVER_USERNAME: 'opencode',
          OPENCODE_SERVER_PASSWORD: 'private-secret',
        },
      },
    });
  });

  it('lets an `ai --codex` pane through, now that the persona serves the recipe', async () => {
    const prepared = {
      preparationId: 'preparation-2',
      agent: 'codex',
      sessionId: 'codex-1',
      launch: { command: '/opt/ai', args: ['resume', 'codex-1', '--remote', 'unix:///tmp/c.sock'], cwd: '/repo' },
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const prepareSession = vi.fn().mockResolvedValue(prepared);
    const result = await prepareSpawnThroughLaunch(
      {
        type: 'launch',
        token: 'secret',
        agent: 'codex',
        cwd: '/repo',
        argv: [],
        pid: 456,
        parentPid: 123,
        imposter: true,
      },
      {
        runtime: {
          prepareSession,
          adoptPrepared: vi.fn().mockResolvedValue({ ...prepared, runtimeSessionId: 'terminal-1', processId: 456 }),
          cancelPrepared: vi.fn(),
        } as never,
        imposterBin: () => '/opt/ai',
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );

    // Two processes, two ways in. The pane's own launch carries the persona in
    // `launch.env`; the private app-server the codex recipe spawns beside it
    // never sees that spec, and `appServerEnv` is the only thing that reaches
    // it (§11.5).
    expect(prepareSession).toHaveBeenCalledWith({
      agent: 'codex',
      cwd: '/repo',
      agentOptions: { executable: '/opt/ai', appServerEnv: { AI_PERSONA: 'codex' } },
    });
    expect(result).toMatchObject({ action: 'exec', launch: { env: { AI_PERSONA: 'codex' } } });
  });

  it('refuses rather than silently launching the real agent when no imposter is installed', async () => {
    const prepareSession = vi.fn();
    const result = await prepareSpawnThroughLaunch(
      {
        type: 'launch',
        token: 'secret',
        agent: 'claude',
        cwd: '/repo',
        argv: [],
        pid: 456,
        parentPid: 123,
        imposter: true,
      },
      {
        runtime: { prepareSession } as never,
        imposterBin: () => undefined,
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );
    expect(result).toMatchObject({ action: 'fallback' });
    expect(prepareSession).not.toHaveBeenCalled();
  });

  it('leaves a normal launch entirely alone', async () => {
    const prepared = {
      preparationId: 'preparation-1',
      agent: 'claude',
      sessionId: 'claude-1',
      launch: { command: '/real/claude', args: [], cwd: '/repo' },
      workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const prepareSession = vi.fn().mockResolvedValue(prepared);
    const result = await prepareSpawnThroughLaunch(
      { type: 'launch', token: 'secret', agent: 'claude', cwd: '/repo', argv: [], pid: 456, parentPid: 123 },
      {
        runtime: {
          prepareSession,
          adoptPrepared: vi.fn().mockResolvedValue({ ...prepared, runtimeSessionId: 'terminal-1', processId: 456 }),
          cancelPrepared: vi.fn(),
        } as never,
        imposterBin: () => '/opt/ai',
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );
    // No agentOptions, no AI_PERSONA: an imposter available on the machine must
    // never change what a plain `claude` does.
    expect(prepareSession).toHaveBeenCalledWith({ agent: 'claude', cwd: '/repo' });
    expect(result).toEqual({ action: 'exec', preparationId: 'preparation-1', launch: prepared.launch });
  });

  it('falls through untouched when the user supplies unsupported arguments', async () => {
    const prepareSession = vi.fn();
    const result = await prepareSpawnThroughLaunch(
      {
        type: 'launch',
        token: 'secret',
        agent: 'codex',
        cwd: '/repo',
        argv: ['--help'],
        pid: 456,
        parentPid: 123,
      },
      {
        runtime: { prepareSession } as never,
        listSessions: async () => [shellSession],
        onAdopted: vi.fn(),
      },
    );

    expect(result).toEqual({ action: 'fallback', reason: 'custom arguments are not spawn-through compatible' });
    expect(prepareSession).not.toHaveBeenCalled();
  });
});
