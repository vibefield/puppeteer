import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibecook/puppeteer-core';
import {
  captureCodexContinuationState,
  normalizeCodexNativeInvocation,
  restoreCodexContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'codex',
  cwd: '/repo',
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

const normalize = (argv: string[], over: Partial<AgentNativeInvocation> = {}) =>
  normalizeCodexNativeInvocation(invocation(argv, over));

const imposter: Partial<AgentNativeInvocation> = {
  implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: '/tmp/codex-imposter' },
};

const THREAD = '64a61b19-f4d8-4f96-ba56-07024b470813';

describe('Codex native invocation normalization', () => {
  it('distinguishes an exact thread id from the native resume selection flow', () => {
    expect(normalize(['resume', THREAD])).toEqual({ status: 'accepted', resume: THREAD });
    expect(normalize(['resume', '--last'])).toEqual({
      status: 'accepted',
      options: { resumeInvocation: ['resume', '--last'] },
    });
  });

  it("keeps today's accepted forms exactly", () => {
    expect(normalize([])).toEqual({ status: 'accepted' });
    expect(normalize(['resume'])).toEqual({ status: 'accepted', options: { resumeInvocation: ['resume'] } });
    expect(normalize(['resume', '--all'])).toEqual({
      status: 'accepted',
      options: { resumeInvocation: ['resume', '--all'] },
    });
  });

  it('owns app-server environment, imposter selection, and continuation state', () => {
    const imposterRoot = '/tmp/codex-imposter';
    expect(
      normalizeCodexNativeInvocation(
        invocation([], {
          environment: { CODEX_HOME: '../codex-home' },
          implementation: { kind: 'imposter', executable: '/opt/ai', stateRoot: imposterRoot },
        }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: '/opt/ai',
        env: { CODEX_HOME: '/codex-home', AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot },
        appServerEnv: {
          CODEX_HOME: '/codex-home',
          AI_PERSONA: 'codex',
          PUPPETEER_IMPOSTER_HOME: imposterRoot,
        },
      },
    });
    const state = captureCodexContinuationState({ appServerEnv: { CODEX_HOME: '../codex-home' } }, '/repo', {});
    expect(restoreCodexContinuationState(state)).toEqual({
      env: { CODEX_HOME: '/codex-home' },
      appServerEnv: { CODEX_HOME: '/codex-home' },
    });
    const imposterState = captureCodexContinuationState(
      { appServerEnv: { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot } },
      '/repo',
      {},
    );
    expect(restoreCodexContinuationState(imposterState, { imposterExecutable: '/opt/ai' })).toEqual({
      executable: '/opt/ai',
      env: { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot },
      appServerEnv: { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot },
    });
    expect(() =>
      restoreCodexContinuationState(JSON.stringify({ version: 2, home: '/codex-home', extra: true })),
    ).toThrow('invalid Codex continuation state');
  });

  it('rejects caller-owned remote transport arguments', () => {
    expect(normalize(['resume', '--remote', 'ws://outside'])).toEqual({
      status: 'rejected',
      reason: 'Codex remote transport arguments are owned by the adapter',
      argument: '--remote',
    });
    expect(normalize(['resume', '--last', 'unexpected-prompt'])).toMatchObject({
      status: 'rejected',
      argument: 'unexpected-prompt',
    });
  });
});

describe('Codex invocation classes', () => {
  it('passes a utility through: help and version anywhere, and every management subcommand', () => {
    for (const argv of [
      ['--version'],
      ['-V'],
      ['--help'],
      ['-h'],
      ['resume', '--help'],
      ['resume', THREAD, '-V'],
      ['fork', '--help'],
      ['login'],
      ['logout'],
      ['mcp', 'list'],
      ['plugin', 'list'],
      ['completion', 'zsh'],
      ['update'],
      ['doctor'],
      ['features', 'list'],
      ['debug', 'models'],
      ['sandbox', 'macos', 'ls'],
      ['apply'],
      ['a'],
      ['archive', THREAD],
      ['unarchive', THREAD],
      ['delete', THREAD],
      ['migrate-rollouts'],
      ['queue', '--thread', THREAD, '--message', 'hi'],
      ['help'],
      ['help', 'resume'],
      ['execpolicy', 'check'],
      ['exec', '--help'],
    ]) {
      expect(normalize(argv), argv.join(' ')).toMatchObject({ status: 'passthrough', kind: 'utility' });
    }
  });

  it('passes a one-shot through', () => {
    for (const argv of [['exec', 'summarize the diff'], ['e', 'q'], ['review'], ['exec', '--json', 'q']]) {
      expect(normalize(argv), argv.join(' ')).toMatchObject({ status: 'passthrough', kind: 'one-shot' });
    }
  });

  it('passes an agent elsewhere through', () => {
    for (const argv of [
      ['cloud'],
      ['cloud-tasks'],
      ['app'],
      ['agents'],
      ['app-server', '--listen', 'stdio://'],
      ['remote-control', 'start'],
      ['exec-server'],
    ]) {
      expect(normalize(argv), argv.join(' ')).toMatchObject({ status: 'passthrough', kind: 'elsewhere' });
    }
  });

  it('ranks the classes: utility, elsewhere, one-shot, then what a session can carry', () => {
    expect(normalize(['-m', 'x', 'exec', 'q'])).toMatchObject({ status: 'passthrough', kind: 'one-shot' });
    expect(normalize(['-m', 'x', 'login'])).toMatchObject({ status: 'passthrough', kind: 'utility' });
    expect(normalize(['--remote', 'ws://x', 'exec', 'q'])).toMatchObject({ kind: 'one-shot' });
    expect(normalize(['--remote', 'ws://x', '--help'])).toMatchObject({ kind: 'utility' });
    expect(normalize(['-C', '/elsewhere', 'cloud'])).toMatchObject({ kind: 'elsewhere' });
    expect(normalize(['exec', '--help'])).toMatchObject({ kind: 'utility' });
  });

  it('rejects every owned argument, every session the recipe cannot carry, and names the argument', () => {
    const cases: Array<[string[], string]> = [
      [['--remote', 'ws://outside'], '--remote'],
      [['--remote=unix:///tmp/x.sock'], '--remote=unix:///tmp/x.sock'],
      [['--remote-auth-token-env', 'TOKEN'], '--remote-auth-token-env'],
      [['resume', '--remote-auth-token-env=TOKEN'], '--remote-auth-token-env=TOKEN'],
      [['fork'], 'fork'],
      [['fork', '--last'], 'fork'],
      [['-C', '/elsewhere'], '-C'],
      [['--cd=/elsewhere'], '--cd=/elsewhere'],
      [['--worktree'], '--worktree'],
      [['--no-daemon'], '--no-daemon'],
      [['--add-dir', '/extra'], '--add-dir'],
      [['-p', 'work'], '-p'],
      [['--oss'], '--oss'],
      [['--local-provider', 'ollama'], '--local-provider'],
      [['--approve-for-me'], '--approve-for-me'],
      [['--dangerously-bypass-hook-trust'], '--dangerously-bypass-hook-trust'],
      [['--strict-config'], '--strict-config'],
      [['resume', '--include-non-interactive'], '--include-non-interactive'],
      [['--bogus'], '--bogus'],
      [['-x'], '-x'],
      [['--last'], '--last'],
    ];
    for (const [argv, argument] of cases) {
      const resolution = normalize(argv);
      expect(resolution, argv.join(' ')).toMatchObject({ status: 'rejected', argument });
      expect(resolution.status === 'rejected' && resolution.reason, argv.join(' ')).toMatch(/^[a-zA-Z][^.]*[^.]$/u);
    }
    expect(normalize(['-C', '/elsewhere'])).toEqual({
      status: 'rejected',
      reason: 'it moves the session to another directory, and a managed session works in the directory it was typed in',
      argument: '-C',
    });
  });

  it('names the first argument, in argv order, that the recipe cannot carry', () => {
    expect(normalize(['--worktree', '-C', '/x'])).toMatchObject({ argument: '--worktree' });
    expect(normalize(['-C', '/x', '--worktree'])).toMatchObject({ argument: '-C' });
    expect(normalize(['-m', 'x', '--add-dir', '/d', '--no-daemon'])).toMatchObject({ argument: '--add-dir' });
  });
});

describe('what a managed Codex session carries', () => {
  it('carries a typed prompt for the TUI to submit, whatever it starts with', () => {
    expect(normalize(['fix the bug'])).toEqual({ status: 'accepted', options: { prompt: 'fix the bug' } });
    expect(normalize(['--', '-v is broken'])).toEqual({ status: 'accepted', options: { prompt: '-v is broken' } });
    expect(normalize(['--', 'resume'])).toEqual({ status: 'accepted', options: { prompt: 'resume' } });
    expect(normalize(['resume', THREAD, 'keep going'])).toEqual({
      status: 'accepted',
      resume: THREAD,
      options: { prompt: 'keep going' },
    });
  });

  it("maps the thread's own start parameters", () => {
    expect(normalize(['-m', 'gpt-5', '-s', 'read-only', '-a', 'never'])).toEqual({
      status: 'accepted',
      options: { model: 'gpt-5', sandbox: 'read-only', approvalPolicy: 'never' },
    });
    expect(normalize(['--model=gpt-5', '--sandbox=workspace-write', '--ask-for-approval=on-request'])).toEqual({
      status: 'accepted',
      options: { model: 'gpt-5', sandbox: 'workspace-write', approvalPolicy: 'on-request' },
    });
    expect(normalize(['--dangerously-bypass-approvals-and-sandbox'])).toEqual({
      status: 'accepted',
      options: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
    });
  });

  it('carries settings to the private server and the TUI, --search as the server setting the TUI makes of it', () => {
    expect(normalize(['-c', 'model_reasoning_effort=high', '--search', '--disable', 'goals', '--enable', 'x'])).toEqual(
      {
        status: 'accepted',
        options: {
          appServerArguments: [
            '--config=model_reasoning_effort=high',
            '--config=web_search=live',
            '--disable=goals',
            '--enable=x',
          ],
          tuiArguments: ['--config=model_reasoning_effort=high', '--search', '--disable=goals', '--enable=x'],
        },
      },
    );
  });

  it('carries TUI presentation and images, each value its own option, in typed order', () => {
    expect(normalize(['--no-alt-screen'])).toEqual({
      status: 'accepted',
      options: { tuiArguments: ['--no-alt-screen'] },
    });
    // clap reads `b.png` as a second image, not as the prompt (parse batch3).
    expect(normalize(['-i', 'a.png', 'b.png'])).toEqual({
      status: 'accepted',
      options: { tuiArguments: ['--image=a.png', '--image=b.png'] },
    });
    expect(normalize(['fix it', '-i', 'a.png', '--no-alt-screen'])).toEqual({
      status: 'accepted',
      options: { prompt: 'fix it', tuiArguments: ['--image=a.png', '--no-alt-screen'] },
    });
    expect(normalize(['resume', THREAD, '--no-alt-screen'])).toEqual({
      status: 'accepted',
      resume: THREAD,
      options: { tuiArguments: ['--no-alt-screen'] },
    });
    expect(normalize(['resume', '--last', '--no-alt-screen'])).toEqual({
      status: 'accepted',
      options: { resumeInvocation: ['resume', '--last'], tuiArguments: ['--no-alt-screen'] },
    });
  });

  it('says one thing once: two options may not decide one setting', () => {
    expect(normalize(['--dangerously-bypass-approvals-and-sandbox', '-s', 'read-only'])).toEqual({
      status: 'rejected',
      reason: '--dangerously-bypass-approvals-and-sandbox already sets the sandbox and the approvals',
      argument: '-s',
    });
    expect(normalize(['-a', 'never', '--dangerously-bypass-approvals-and-sandbox'])).toMatchObject({
      argument: '--dangerously-bypass-approvals-and-sandbox',
    });
    expect(normalize(['-m', 'x', '-c', 'model=y'])).toMatchObject({ reason: 'model is given twice', argument: '-c' });
    expect(normalize(['-c', 'web_search=cached', '--search'])).toMatchObject({ argument: '--search' });
    expect(normalize(['--enable', 'goals', '--disable', 'goals'])).toMatchObject({ argument: '--disable' });
    expect(normalize(['-c', 'features.goals=false', '--enable', 'goals'])).toMatchObject({ argument: '--enable' });
    // The same option twice is what was typed: codex reads both in order, and so does the server.
    expect(normalize(['-c', 'k=1', '-c', 'k=2'])).toMatchObject({ status: 'accepted' });
  });

  it('refuses a -c the recipe would override, and a -c codex cannot read', () => {
    for (const setting of [
      'sandbox_mode="read-only"',
      'approval_policy=never',
      'sandbox_workspace_write.network_access=true',
      'projects."/repo".trust_level="trusted"',
      'profile=work',
    ]) {
      expect(normalize(['-c', setting]), setting).toEqual({
        status: 'rejected',
        reason: 'a managed session sets the sandbox and approvals itself, so this setting would not take effect',
        argument: '-c',
      });
    }
    expect(normalize(['-c', 'nonsense'])).toEqual({ status: 'rejected', reason: '-c needs key=value', argument: '-c' });
  });

  it('carries into a resumed session only what cannot change it', () => {
    expect(normalize(['resume', THREAD, '-m', 'x'])).toMatchObject({ status: 'rejected', argument: '-m' });
    expect(normalize(['-s', 'read-only', 'resume', '--last'])).toMatchObject({ status: 'rejected', argument: '-s' });
    expect(normalize(['resume', '--last', '-c', 'k=v'])).toMatchObject({ status: 'rejected', argument: '-c' });
    expect(normalize(['resume', 'my-session'])).toMatchObject({ status: 'rejected', argument: 'my-session' });
    expect(normalize(['resume', '--last', '--all'])).toMatchObject({ status: 'rejected', argument: '--all' });
    expect(normalize(['hello', 'resume'])).toMatchObject({ status: 'rejected', argument: 'hello' });
    expect(normalize(['resume', '-i', 'a.png'])).toMatchObject({ status: 'rejected', argument: '-i' });
  });

  it("carries to the imposter only the thread's start parameters its app-server takes", () => {
    expect(normalize(['-m', 'x', '-s', 'read-only'], imposter)).toMatchObject({
      status: 'accepted',
      options: { model: 'x', sandbox: 'read-only', executable: '/opt/ai' },
    });
    for (const [argv, argument] of [
      [['fix it'], 'fix it'],
      [['--no-alt-screen'], '--no-alt-screen'],
      [['-c', 'k=v'], '-c'],
      [['--search'], '--search'],
      [['-i', 'a.png'], '-i'],
    ] as Array<[string[], string]>) {
      expect(normalize(argv, imposter), argv.join(' ')).toEqual({
        status: 'rejected',
        reason: 'the imposter stand-in cannot carry this argument',
        argument,
      });
    }
    expect(normalize(['resume', '--last'], imposter)).toMatchObject({
      status: 'accepted',
      options: { resumeInvocation: ['resume', '--last'] },
    });
  });

  it('never persists a carried argument: continuation state is the launch environment alone', () => {
    const resolution = normalize(['-m', 'gpt-5', '--search', 'fix it', '--no-alt-screen'], {
      environment: { CODEX_HOME: '/codex-home' },
    });
    expect(resolution.status).toBe('accepted');
    const options = resolution.status === 'accepted' ? resolution.options : undefined;
    const state = captureCodexContinuationState(options, '/repo', {});
    expect(JSON.parse(state!)).toEqual({ version: 2, home: '/codex-home' });
    expect(restoreCodexContinuationState(state)).toEqual({
      env: { CODEX_HOME: '/codex-home' },
      appServerEnv: { CODEX_HOME: '/codex-home' },
    });
  });
});
