import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentNativeInvocation } from '@vibefield/puppeteer-core';
import {
  captureCodexContinuationState,
  normalizeCodexNativeInvocation,
  restoreCodexContinuationState,
} from './native-invocation.js';

const invocation = (argv: string[], over: Partial<AgentNativeInvocation> = {}): AgentNativeInvocation => ({
  providerId: 'codex',
  cwd: resolve('/repo'),
  argv,
  environment: {},
  implementation: { kind: 'native' },
  ...over,
});

const normalize = (argv: string[], over: Partial<AgentNativeInvocation> = {}) =>
  normalizeCodexNativeInvocation(invocation(argv, over));

const imposter: Partial<AgentNativeInvocation> = {
  implementation: { kind: 'imposter', executable: resolve('/opt/ai'), stateRoot: resolve('/tmp/codex-imposter') },
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

  it("keeps today's resume forms exactly, and starts a bare codex from the person's configuration", () => {
    expect(normalize([])).toEqual({ status: 'accepted', options: { permissionDefaults: 'configuration' } });
    expect(normalize(['resume'])).toEqual({ status: 'accepted', options: { resumeInvocation: ['resume'] } });
    expect(normalize(['resume', '--all'])).toEqual({
      status: 'accepted',
      options: { resumeInvocation: ['resume', '--all'] },
    });
  });

  it('leaves to the configuration only what a typed launch did not name, and never for a resume or the imposter', () => {
    expect(normalize(['-s', 'read-only'])).toEqual({
      status: 'accepted',
      options: { sandbox: 'read-only', permissionDefaults: 'configuration' },
    });
    expect(normalize(['-a', 'never'])).toEqual({
      status: 'accepted',
      options: { approvalPolicy: 'never', permissionDefaults: 'configuration' },
    });
    for (const [argv, over] of [
      [['resume', THREAD], {}],
      [['resume', '--last'], {}],
      [['resume', THREAD, 'go on'], {}],
      [[], imposter],
    ] as Array<[string[], Partial<AgentNativeInvocation>]>) {
      const resolution = normalize(argv, over);
      expect(resolution.status, argv.join(' ')).toBe('accepted');
      const options = resolution.status === 'accepted' ? resolution.options : undefined;
      expect(options?.permissionDefaults, argv.join(' ')).toBeUndefined();
    }
  });

  it('owns app-server environment, imposter selection, and continuation state', () => {
    const imposterRoot = resolve('/tmp/codex-imposter');
    expect(
      normalizeCodexNativeInvocation(
        invocation([], {
          environment: { CODEX_HOME: '../codex-home' },
          implementation: { kind: 'imposter', executable: resolve('/opt/ai'), stateRoot: imposterRoot },
        }),
      ),
    ).toEqual({
      status: 'accepted',
      options: {
        executable: resolve('/opt/ai'),
        env: { CODEX_HOME: resolve('/codex-home'), AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot },
        appServerEnv: {
          CODEX_HOME: resolve('/codex-home'),
          AI_PERSONA: 'codex',
          PUPPETEER_IMPOSTER_HOME: imposterRoot,
        },
      },
    });
    const state = captureCodexContinuationState(
      { appServerEnv: { CODEX_HOME: '../codex-home' } },
      resolve('/repo'),
      {},
    );
    expect(restoreCodexContinuationState(state)).toEqual({
      env: { CODEX_HOME: resolve('/codex-home') },
      appServerEnv: { CODEX_HOME: resolve('/codex-home') },
    });
    const imposterState = captureCodexContinuationState(
      { appServerEnv: { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot } },
      resolve('/repo'),
      {},
    );
    expect(restoreCodexContinuationState(imposterState, { imposterExecutable: resolve('/opt/ai') })).toEqual({
      executable: resolve('/opt/ai'),
      env: { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot },
      appServerEnv: { AI_PERSONA: 'codex', PUPPETEER_IMPOSTER_HOME: imposterRoot },
    });
    expect(() =>
      restoreCodexContinuationState(JSON.stringify({ version: 2, home: resolve('/codex-home'), extra: true })),
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
      ['migrate-nfs-db', '--staging-dir', 'staging'],
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
    expect(normalize(['-C', resolve('/elsewhere'), 'cloud'])).toMatchObject({ kind: 'elsewhere' });
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
      [['-C', resolve('/elsewhere')], '-C'],
      [['--cd=/elsewhere'], '--cd=/elsewhere'],
      [['--worktree'], '--worktree'],
      [['--no-daemon'], '--no-daemon'],
      [['--add-dir', resolve('/extra')], '--add-dir'],
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
    expect(normalize(['-C', resolve('/elsewhere')])).toEqual({
      status: 'rejected',
      reason: 'it moves the session to another directory, and a managed session works in the directory it was typed in',
      argument: '-C',
    });
  });

  it('names the first argument, in argv order, that the recipe cannot carry', () => {
    expect(normalize(['--worktree', '-C', resolve('/x')])).toMatchObject({ argument: '--worktree' });
    expect(normalize(['-C', resolve('/x'), '--worktree'])).toMatchObject({ argument: '-C' });
    expect(normalize(['-m', 'x', '--add-dir', resolve('/d'), '--no-daemon'])).toMatchObject({ argument: '--add-dir' });
  });
});

describe('what a managed Codex session carries', () => {
  it('carries a typed prompt for the TUI to submit, whatever it starts with', () => {
    const fresh = { permissionDefaults: 'configuration' };
    expect(normalize(['fix the bug'])).toEqual({ status: 'accepted', options: { prompt: 'fix the bug', ...fresh } });
    expect(normalize(['--', '-v is broken'])).toEqual({
      status: 'accepted',
      options: { prompt: '-v is broken', ...fresh },
    });
    expect(normalize(['--', 'resume'])).toEqual({ status: 'accepted', options: { prompt: 'resume', ...fresh } });
    expect(normalize(['resume', THREAD, 'keep going'])).toEqual({
      status: 'accepted',
      resume: THREAD,
      options: { prompt: 'keep going' },
    });
  });

  it("maps the thread's own start parameters", () => {
    const fresh = { permissionDefaults: 'configuration' };
    expect(normalize(['-m', 'gpt-5', '-s', 'read-only', '-a', 'never'])).toEqual({
      status: 'accepted',
      options: { model: 'gpt-5', sandbox: 'read-only', approvalPolicy: 'never', ...fresh },
    });
    expect(normalize(['--model=gpt-5', '--sandbox=workspace-write', '--ask-for-approval=on-request'])).toEqual({
      status: 'accepted',
      options: { model: 'gpt-5', sandbox: 'workspace-write', approvalPolicy: 'on-request', ...fresh },
    });
    expect(normalize(['--dangerously-bypass-approvals-and-sandbox'])).toEqual({
      status: 'accepted',
      options: { sandbox: 'danger-full-access', approvalPolicy: 'never', ...fresh },
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
          permissionDefaults: 'configuration',
        },
      },
    );
  });

  it('carries TUI presentation and images, each value its own option, in typed order', () => {
    const fresh = { permissionDefaults: 'configuration' };
    expect(normalize(['--no-alt-screen'])).toEqual({
      status: 'accepted',
      options: { tuiArguments: ['--no-alt-screen'], ...fresh },
    });
    // clap reads `b.png` as a second image, not as the prompt (parse batch3).
    expect(normalize(['-i', 'a.png', 'b.png'])).toEqual({
      status: 'accepted',
      options: { tuiArguments: ['--image=a.png', '--image=b.png'], ...fresh },
    });
    expect(normalize(['fix it', '-i', 'a.png', '--no-alt-screen'])).toEqual({
      status: 'accepted',
      options: { prompt: 'fix it', tuiArguments: ['--image=a.png', '--no-alt-screen'], ...fresh },
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

  it('carries the sandbox and approval settings to the server that starts the thread alone, never to the TUI', () => {
    for (const setting of [
      'sandbox_mode="read-only"',
      'approval_policy="never"',
      'sandbox_workspace_write.network_access=true',
      'sandbox_workspace_write.writable_roots=["/extra"]',
      '"sandbox_mode" = "danger-full-access"',
    ]) {
      // The TUI refuses them on a remote resume (S30, S32) and adopts the thread's instead (S25, S26).
      expect(normalize(['-c', setting]), setting).toEqual({
        status: 'accepted',
        options: { appServerArguments: [`--config=${setting}`], permissionDefaults: 'configuration' },
      });
    }
    // Typed alongside -s or -a, the setting is still the configuration the thread takes the other half from.
    expect(
      normalize(['-s', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort=high']),
    ).toEqual({
      status: 'accepted',
      options: {
        sandbox: 'workspace-write',
        appServerArguments: ['--config=approval_policy="never"', '--config=model_reasoning_effort=high'],
        tuiArguments: ['--config=model_reasoning_effort=high'],
        permissionDefaults: 'configuration',
      },
    });
  });

  it('says the sandbox and the approvals once: a -c for either conflicts with -s, -a and the bypass flag', () => {
    expect(normalize(['-s', 'read-only', '-c', 'sandbox_mode="workspace-write"'])).toEqual({
      status: 'rejected',
      reason: 'sandbox_mode is given twice',
      argument: '-c',
    });
    expect(normalize(['-c', '"sandbox_mode"="read-only"', '-s', 'read-only'])).toMatchObject({
      reason: 'sandbox_mode is given twice',
      argument: '-s',
    });
    expect(normalize(['-a', 'never', '-c', 'approval_policy="on-request"'])).toMatchObject({
      reason: 'approval_policy is given twice',
      argument: '-c',
    });
    expect(normalize(['--dangerously-bypass-approvals-and-sandbox', '-c', 'approval_policy="never"'])).toEqual({
      status: 'rejected',
      reason: '--dangerously-bypass-approvals-and-sandbox already sets the sandbox and the approvals',
      argument: '-c',
    });
    expect(normalize(['-c', 'sandbox_mode="read-only"', '--dangerously-bypass-approvals-and-sandbox'])).toMatchObject({
      argument: '--dangerously-bypass-approvals-and-sandbox',
    });
    // The workspace-write details are not the mode: typed with the bypass flag, codex ignores them, and so does the server.
    expect(
      normalize(['--dangerously-bypass-approvals-and-sandbox', '-c', 'sandbox_workspace_write.network_access=true']),
    ).toMatchObject({ status: 'accepted' });
  });

  it('refuses a -c for a setting no probe has shown reaching the thread, each with its own reason', () => {
    for (const [setting, reason] of [
      ['approvals_reviewer="user"', 'it changes who reviews approvals, which a managed session cannot pass on yet'],
      ['default_permissions=":read-only"', 'it picks a permission profile, which a managed session cannot pass on yet'],
      [
        'permissions.probe={network={enabled=false}}',
        'it defines a permission profile, which a managed session cannot pass on yet',
      ],
      [
        'sandbox_permissions=["disk-full-read-access"]',
        'it grants the sandbox extra permissions, which a managed session cannot pass on yet',
      ],
      [
        'projects."/repo".trust_level="trusted"',
        'it changes which folders codex trusts, which a managed session cannot pass on yet',
      ],
      ['profile=work', 'it selects a settings profile, which a managed session cannot pass on yet'],
      ['"profile" = "work"', 'it selects a settings profile, which a managed session cannot pass on yet'],
    ]) {
      expect(normalize(['-c', setting!]), setting).toEqual({ status: 'rejected', reason, argument: '-c' });
    }
    // Only a setting's own key: an inherited property name is just an unknown setting, carried.
    expect(normalize(['-c', 'constructor=1'])).toMatchObject({ status: 'accepted' });
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
    const started = normalize(['-m', 'x', '-s', 'read-only'], imposter);
    expect(started).toMatchObject({
      status: 'accepted',
      options: { model: 'x', sandbox: 'read-only', executable: resolve('/opt/ai') },
    });
    // The imposter has no configuration to read: its thread keeps the adapter's defaults.
    expect(started.status === 'accepted' ? started.options?.permissionDefaults : 'rejected').toBeUndefined();
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
      environment: { CODEX_HOME: resolve('/codex-home') },
    });
    expect(resolution.status).toBe('accepted');
    const options = resolution.status === 'accepted' ? resolution.options : undefined;
    expect(options).toMatchObject({ permissionDefaults: 'configuration' });
    const state = captureCodexContinuationState(options, resolve('/repo'), {});
    expect(JSON.parse(state!)).toEqual({ version: 2, home: resolve('/codex-home') });
    expect(restoreCodexContinuationState(state)).toEqual({
      env: { CODEX_HOME: resolve('/codex-home') },
      appServerEnv: { CODEX_HOME: resolve('/codex-home') },
    });
  });
});
