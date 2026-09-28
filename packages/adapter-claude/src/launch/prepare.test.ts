import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupClaudeSession,
  hasClaudeOtelExporterConflict,
  prepareClaudeSession,
  statusLineForwarderCommand,
  type PreparedClaudeSession,
} from './prepare.js';
import { generateHookSettings } from './settings.js';
import { readClaudeInvocation } from './invocation-grammar.js';
import { normalizeClaudeNativeInvocation } from './native-invocation.js';
import { createHookBridge } from '../observation/hook-bridge.js';

function runStatusLine(command: string, input: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`))));
    child.stdin.end(input);
  });
}

function runExecutable(command: string, args: string[], input: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`))));
    child.stdin.end(input);
  });
}

const BASE = {
  cwd: '/work/repo',
  endpoint: 'http://127.0.0.1:4100/hooks',
  tokenEnvVar: 'PUPPETEER_HOOK_TOKEN',
  token: 'super-secret-token-value',
};

const prepared: PreparedClaudeSession[] = [];
const prepare = async (over: Partial<Parameters<typeof prepareClaudeSession>[0]> = {}) => {
  const p = await prepareClaudeSession({ ...BASE, ...over });
  prepared.push(p);
  return p;
};

afterEach(async () => {
  await Promise.all(prepared.splice(0).map(cleanupClaudeSession));
});

describe('prepareClaudeSession', () => {
  it('generates a UUID session id when none is supplied and keys the file by it', async () => {
    const p = await prepare();
    expect(p.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(p.settingsPath).toContain(p.sessionId);
    expect(p.args).toEqual(expect.arrayContaining(['--session-id', p.sessionId]));
  });

  it('reuses a caller-supplied native correlation id', async () => {
    const p = await prepare({ sessionId: 'fixed-session-id' });
    expect(p.sessionId).toBe('fixed-session-id');
  });

  it('round-trips: file exists and parses to the generated settings; cleanup removes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-test-'));
    const p = await prepare({ settingsDir: dir });
    expect(existsSync(p.settingsPath)).toBe(true);
    expect(existsSync(p.hookForwarderPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(p.settingsPath, 'utf8'));
    expect(onDisk).toEqual(
      generateHookSettings({
        endpoint: BASE.endpoint,
        tokenEnvVar: BASE.tokenEnvVar,
        commandForwarderPath: p.hookForwarderPath,
        commandExecutable: process.execPath,
      }),
    );

    await cleanupClaudeSession(p);
    expect(existsSync(p.settingsPath)).toBe(false);
  });

  it('mkdtemp path: owns and cleans the created directory', async () => {
    const p = await prepareClaudeSession(BASE);
    const dir = join(p.settingsPath, '..');
    expect(existsSync(dir)).toBe(true);
    await cleanupClaudeSession(p);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(p.settingsPath)).toBe(false);
  });

  it('a caller-supplied settingsDir is not scheduled for removal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-keep-'));
    const p = await prepare({ settingsDir: dir });
    expect(p.filesToCleanup).toEqual([p.settingsPath, p.hookForwarderPath]);
    await cleanupClaudeSession(p);
    expect(existsSync(dir)).toBe(true); // caller's dir survives
  });

  it('SECURITY: token value never lands on disk, only in env', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-sec-'));
    const p = await prepare({ settingsDir: dir });
    const text = readFileSync(p.settingsPath, 'utf8');
    expect(text).not.toContain(BASE.token);
    expect(text).toContain('$PUPPETEER_HOOK_TOKEN');
    expect(readFileSync(p.hookForwarderPath, 'utf8')).not.toContain(BASE.token);
    expect(p.env).toEqual({ PUPPETEER_HOOK_TOKEN: BASE.token });
  });

  it('configures only authenticated OTLP logs and detects caller-owned exporters', async () => {
    const p = await prepare({ otelLogsEndpoint: 'http://127.0.0.1:4100/v1/logs' });
    expect(p.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:4100/v1/logs',
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer%20${BASE.token}`,
      OTEL_LOGS_EXPORT_INTERVAL: '1000',
    });
    expect(p.env).not.toHaveProperty('OTEL_METRICS_EXPORTER');
    expect(p.env).not.toHaveProperty('OTEL_TRACES_EXPORTER');
    expect(readFileSync(p.settingsPath, 'utf8')).not.toContain(BASE.token);
    expect(hasClaudeOtelExporterConflict({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(true);
    expect(hasClaudeOtelExporterConflict({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toBe(true);
    expect(hasClaudeOtelExporterConflict({ OTEL_EXPORTER_OTLP_LOGS_COMPRESSION: 'gzip' })).toBe(true);
    expect(hasClaudeOtelExporterConflict({ OTEL_LOGS_EXPORT_INTERVAL: '5000' })).toBe(true);
    expect(hasClaudeOtelExporterConflict({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' })).toBe(false);
  });

  it('posts command-only hooks through the generated Node forwarder', async () => {
    const received: Record<string, unknown>[] = [];
    const bridge = createHookBridge({
      token: BASE.token,
      allowSession: () => true,
    });
    await bridge.start();
    bridge.onEvent((envelope) => received.push(envelope.body));
    try {
      const p = await prepare({ endpoint: bridge.endpoint() });
      const settings = JSON.parse(readFileSync(p.settingsPath, 'utf8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>>;
      };
      const payload = JSON.stringify({
        session_id: p.sessionId,
        transcript_path: '/workspace/transcript.jsonl',
        cwd: '/workspace',
        hook_event_name: 'SessionStart',
        source: 'startup',
      });
      const handler = settings.hooks.SessionStart![0]!.hooks[0]!;
      await expect(runExecutable(handler.command, handler.args, payload, p.env)).resolves.toBe('');
      expect(received).toEqual([JSON.parse(payload)]);
    } finally {
      await bridge.dispose();
    }
  });

  it('builds a native-interactive command and NEVER structured print flags', async () => {
    const p = await prepare({
      executable: '/opt/claude',
      title: 'my session',
      model: 'claude-fable-5',
      effort: 'high',
      settingSources: ['project', 'local'],
      permissionMode: 'plan',
    });
    expect(p.command).toBe('/opt/claude');
    expect(p.args).toEqual([
      '--session-id',
      p.sessionId,
      '--name',
      'my session',
      '--model',
      'claude-fable-5',
      '--effort',
      'high',
      '--setting-sources',
      'project,local',
      '--settings',
      p.settingsPath,
      '--permission-mode',
      'plan',
    ]);
    for (const forbidden of ['-p', '--print', '--output-format', '--input-format']) {
      expect(p.args).not.toContain(forbidden);
    }
  });

  it('does not delegate status lines from native settings sources excluded by the launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prepare-setting-sources-'));
    const project = join(root, 'project');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'project-line' } }),
    );
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'excluded-local-line' } }),
    );
    try {
      const p = await prepare({
        cwd: project,
        settingSources: ['project'],
        statusLineEndpoint: 'http://127.0.0.1:1/statusline',
      });
      expect(p.args).toEqual(expect.arrayContaining(['--setting-sources', 'project']));
      expect(p.env.PUPPETEER_STATUSLINE_DELEGATE).toBe('project-line');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves and preserves an explicit Claude config directory for user status delegation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prepare-config-dir-'));
    const configDir = join(root, 'claude-work');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'relocated-user-line' } }),
    );
    try {
      const p = await prepare({
        cwd: root,
        configDir: 'claude-work',
        settingSources: ['user'],
        statusLineEndpoint: 'http://127.0.0.1:1/statusline',
      });
      expect(p.env.CLAUDE_CONFIG_DIR).toBe(configDir);
      expect(p.env.PUPPETEER_STATUSLINE_DELEGATE).toBe('relocated-user-line');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an empty explicit setting source list before creating launch files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'prepare-empty-setting-sources-'));
    try {
      await expect(prepare({ settingsDir: root, settingSources: [] })).rejects.toThrow(
        'must contain at least one source',
      );
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults command to claude and permission-mode to default; omits --name without a title', async () => {
    const p = await prepare();
    expect(p.command).toBe('claude');
    expect(p.args).toContain('--permission-mode');
    expect(p.args[p.args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(p.args).not.toContain('--name');
  });

  describe('a typed launch', () => {
    /** The recipe for a typed `claude <argv>`, as the provider hands the adapter's options on. */
    async function typedLaunch(argv: string[]) {
      const resolution = normalizeClaudeNativeInvocation({
        providerId: 'claude',
        cwd: BASE.cwd,
        argv,
        environment: {},
        implementation: { kind: 'native' },
      });
      if (resolution.status !== 'accepted') throw new Error(`not accepted: ${JSON.stringify(resolution)}`);
      const options = resolution.options!;
      return prepare({
        ...(resolution.resume === undefined ? {} : { resume: resolution.resume }),
        resumeInvocation: options.resumeInvocation,
        title: options.title,
        model: options.model,
        permissionMode: options.permissionMode ?? null,
        carriedArgs: options.carriedArgs,
        prompt: options.prompt,
      });
    }

    /** Where the person's part of the recipe starts: after the managed launch's own flags. */
    function personPart(args: string[]): string[] {
      const settings = args.indexOf('--settings');
      const mode = args[settings + 2] === '--permission-mode' ? 2 : 0;
      return args.slice(settings + 2 + mode);
    }

    it('puts the managed flags first, the carried arguments next in the person’s order, the prompt last after `--`', async () => {
      const p = await typedLaunch(['fix the bug', '--add-dir', '../lib', '../docs', '--verbose', '--model', 'opus']);
      expect(p.args).toEqual([
        '--session-id',
        p.sessionId,
        '--model',
        'opus',
        '--settings',
        p.settingsPath,
        '--add-dir',
        '../lib',
        '../docs',
        '--verbose',
        '--',
        'fix the bug',
      ]);
    });

    it('a trailing variadic of the person’s takes no managed flag, and the prompt stays the prompt', async () => {
      const p = await typedLaunch(['fix it', '--add-dir', 'a', 'b']);
      expect(p.args.slice(-5)).toEqual(['--add-dir', 'a', 'b', '--', 'fix it']);
      // Every managed flag comes before the person's first argument.
      for (const flag of ['--session-id', '--settings'])
        expect(p.args.indexOf(flag)).toBeLessThan(p.args.indexOf('--add-dir'));
      // Read back, the person's part means what was typed: two directories and a prompt.
      expect(readClaudeInvocation(personPart(p.args))).toMatchObject({
        status: 'accepted',
        carriedArgs: ['--add-dir', 'a', 'b'],
        prompt: ['fix it'],
      });
    });

    it('a managed flag’s value is never read as the prompt: a resume picker is followed by a flag, the prompt by `--`', async () => {
      const p = await typedLaunch(['-r', '--', 'where were we']);
      expect(p.args[0]).toBe('-r');
      expect(p.args[1]!.startsWith('-')).toBe(true);
      expect(p.args.slice(-2)).toEqual(['--', 'where were we']);
      expect(readClaudeInvocation(p.args.slice(-2))).toMatchObject({ status: 'accepted', prompt: ['where were we'] });
    });

    it('a prompt that looks like a flag stays a prompt', async () => {
      const p = await typedLaunch(['--', '--help']);
      expect(p.args.slice(-2)).toEqual(['--', '--help']);
      expect(readClaudeInvocation(personPart(p.args))).toMatchObject({ status: 'accepted', prompt: ['--help'] });
    });

    it('says each thing once: no permission mode of its own, one --name, the person’s mode when given', async () => {
      const bare = await typedLaunch([]);
      expect(bare.args).toEqual(['--session-id', bare.sessionId, '--settings', bare.settingsPath]);
      const skip = await typedLaunch(['--dangerously-skip-permissions']);
      expect(skip.args).not.toContain('--permission-mode');
      expect(skip.args.filter((argument) => argument === '--dangerously-skip-permissions')).toHaveLength(1);
      const both = await typedLaunch(['--permission-mode', 'plan', '--dangerously-skip-permissions']);
      expect(both.args.filter((argument) => argument === '--permission-mode')).toHaveLength(1);
      expect(both.args[both.args.indexOf('--permission-mode') + 1]).toBe('plan');
      expect(both.args).toContain('--dangerously-skip-permissions');
      const named = await typedLaunch(['-n', 'mine']);
      expect(named.args.filter((argument) => argument === '--name' || argument === '-n')).toEqual(['--name']);
      expect(named.args[named.args.indexOf('--name') + 1]).toBe('mine');
    });

    it('a host’s own spawn keeps its default permission mode', async () => {
      const p = await prepare({ carriedArgs: undefined, prompt: undefined });
      expect(p.args.slice(-2)).toEqual(['--permission-mode', 'default']);
    });
  });

  /** A config root holding one conversation, the way Claude lays its projects out. */
  function conversationRoot(resumeId: string): string {
    const root = mkdtempSync(join(tmpdir(), 'prepare-resume-'));
    const project = join(root, 'projects', '-work-repo');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${resumeId}.jsonl`), '');
    return root;
  }

  it('resume uses --resume with the resumed id and NEVER --session-id (mutually exclusive)', async () => {
    const resumeId = '64a61b19-f4d8-4f96-ba56-07024b470813';
    const p = await prepare({ resume: resumeId, configDir: conversationRoot(resumeId) });
    expect(p.sessionId).toBe(resumeId); // join contract preserved: same id
    expect(p.args).toContain('--resume');
    expect(p.args[p.args.indexOf('--resume') + 1]).toBe(resumeId);
    expect(p.args).not.toContain('--session-id');
    // Settings still attach on resume (the hook bridge follows a resumed session).
    expect(p.args).toContain('--settings');
  });

  it('refuses to resume a conversation that is not on disk, before anything is launched', async () => {
    const resumeId = '64a61b19-f4d8-4f96-ba56-07024b470814';
    const root = mkdtempSync(join(tmpdir(), 'prepare-resume-missing-'));
    mkdirSync(join(root, 'projects', '-elsewhere'), { recursive: true });
    await expect(prepare({ resume: resumeId, configDir: root })).rejects.toMatchObject({
      name: 'ClaudeConversationMissingError',
      code: 'CLAUDE_CONVERSATION_MISSING',
      sessionId: resumeId,
    });
    // The imposter keeps the same layout under its own state root.
    const imposterRoot = conversationRoot(resumeId);
    const p = await prepare({ resume: resumeId, env: { PUPPETEER_IMPOSTER_HOME: imposterRoot } });
    expect(p.args).toContain('--resume');
  });

  it('preserves a native resume picker invocation without forcing --session-id', async () => {
    const p = await prepare({ resumeInvocation: ['--resume'] });
    expect(p.args[0]).toBe('--resume');
    expect(p.args).not.toContain('--session-id');
    expect(p.args).toEqual(expect.arrayContaining(['--settings', p.settingsPath]));
  });

  it('wraps a script executable with the current node (emulator bin, shims)', async () => {
    const p = await prepare({ executable: '/abs/path/bin.mjs' });
    expect(p.command).toBe(process.execPath);
    expect(p.args[0]).toBe('/abs/path/bin.mjs');
    expect(p.args).toContain('--session-id');
    // Binary executables pass through untouched.
    const binary = await prepare({ executable: '/usr/local/bin/claude' });
    expect(binary.command).toBe('/usr/local/bin/claude');
    expect(binary.args[0]).toBe('--session-id');
  });

  it('under Electron, script recipes resolve a real node from PATH (electron-as-node only as fallback)', async () => {
    process.versions.electron = '43.1.0';
    try {
      const p = await prepare({ executable: '/abs/path/bin.mjs' });
      // A dev machine running this repo has node on PATH, so it wins.
      expect(p.command.toLowerCase()).toContain('node');
      expect(p.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(p.args[0]).toBe('/abs/path/bin.mjs');
    } finally {
      delete process.versions.electron;
    }
  });

  it("wires FileChanged only when a caller supplies Claude's filename matcher", async () => {
    const p = await prepare({ fileChangeMatcher: '.envrc|.env' });
    const settings = JSON.parse(readFileSync(p.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string }>>;
    };
    expect(settings.hooks.FileChanged).toEqual([expect.objectContaining({ matcher: '.envrc|.env' })]);
  });

  it('encodes Windows status-line paths without exposing them to either outer shell', () => {
    const executable = 'C:\\Program Files\\Node $Runtime\\node.exe';
    const script = "C:\\Users\\O'Brien\\hook `status`.mjs";
    const command = statusLineForwarderCommand(executable, script, 'win32');
    const encoded = command.split(' ').at(-1)!;
    expect(command).not.toContain(executable);
    expect(command).not.toContain(script);
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(
      `& '${executable}' '${script.replaceAll("'", "''")}'`,
    );

    const childCommand = statusLineForwarderCommand(executable, script, 'win32', 'subagent');
    expect(Buffer.from(childCommand.split(' ').at(-1)!, 'base64').toString('utf16le')).toBe(
      `& '${executable}' '${script.replaceAll("'", "''")}' 'subagent'`,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'runs a POSIX status-line forwarder from paths with spaces and shell metacharacters',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'prepare-status-special-'));
      const dir = join(root, "settings $d'ir");
      mkdirSync(dir);
      try {
        const p = await prepare({
          settingsDir: dir,
          statusLineEndpoint: 'http://127.0.0.1:1/statusline',
          existingStatusLine: null,
        });
        const settings = JSON.parse(readFileSync(p.settingsPath, 'utf8')) as { statusLine: { command: string } };
        await expect(runStatusLine(settings.statusLine.command, '{}', p.env)).resolves.toBe('');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('multiplexes context telemetry while preserving the existing status-line output and presentation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-statusline-'));
    const delegatePath = join(dir, 'delegate.mjs');
    writeFileSync(
      delegatePath,
      "let input=''; for await (const chunk of process.stdin) input += chunk; console.log('original:' + JSON.parse(input).session_id);",
    );
    const delegate = `node ${JSON.stringify(delegatePath)}`;
    const p = await prepare({
      settingsDir: dir,
      statusLineEndpoint: 'http://127.0.0.1:1/statusline',
      existingStatusLine: {
        type: 'command',
        command: delegate,
        padding: 2,
        refreshInterval: 3,
        hideVimModeIndicator: true,
      },
    });
    const settings = JSON.parse(readFileSync(p.settingsPath, 'utf8')) as {
      statusLine: {
        type: string;
        command: string;
        padding?: number;
        refreshInterval?: number;
        hideVimModeIndicator?: boolean;
      };
    };

    expect(p.statusLineForwarderPath).toBeDefined();
    expect(existsSync(p.statusLineForwarderPath!)).toBe(true);
    expect(settings.statusLine).toMatchObject({
      type: 'command',
      padding: 2,
      refreshInterval: 3,
      hideVimModeIndicator: true,
    });
    expect(settings.statusLine.command).not.toContain(delegate);
    expect(p.env).toMatchObject({
      PUPPETEER_STATUSLINE_ENDPOINT: 'http://127.0.0.1:1/statusline',
      PUPPETEER_STATUSLINE_DELEGATE: delegate,
      PUPPETEER_STATUSLINE_TOKEN_ENV_VAR: BASE.tokenEnvVar,
    });
    expect(readFileSync(p.statusLineForwarderPath!, 'utf8')).not.toContain(BASE.token);

    await expect(
      runStatusLine(settings.statusLine.command, JSON.stringify({ session_id: 'session-42' }), p.env),
    ).resolves.toBe('original:session-42\n');
  });

  it('multiplexes root and child commands independently and forwards the original child payload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-child-statusline-'));
    const childDelegatePath = join(dir, 'child-delegate.mjs');
    writeFileSync(
      childDelegatePath,
      "let input=''; for await (const chunk of process.stdin) input += chunk; for (const task of JSON.parse(input).tasks) console.log(JSON.stringify({id: task.id, content: 'original:' + task.id}));",
    );
    const childDelegate = `node ${JSON.stringify(childDelegatePath)}`;
    const bridge = createHookBridge({ token: BASE.token, allowSession: () => true });
    await bridge.start();
    const childPayload = new Promise<unknown>((resolve) => {
      bridge.onSubagentStatusLine((envelope) => resolve(envelope.body));
    });
    try {
      const p = await prepare({
        settingsDir: dir,
        statusLineEndpoint: bridge.statusLineEndpoint(),
        subagentStatusLineEndpoint: bridge.subagentStatusLineEndpoint(),
        existingStatusLine: { type: 'command', command: `${process.execPath} -e "process.exit(7)"` },
        existingSubagentStatusLine: { type: 'command', command: childDelegate },
      });
      const settings = JSON.parse(readFileSync(p.settingsPath, 'utf8')) as {
        statusLine: { command: string };
        subagentStatusLine: { command: string };
      };
      await expect(
        runStatusLine(settings.statusLine.command, JSON.stringify({ session_id: p.sessionId }), p.env),
      ).rejects.toThrow();

      const payload = { session_id: p.sessionId, tasks: [{ id: 'task-1' }] };
      await expect(
        runStatusLine(settings.subagentStatusLine.command, JSON.stringify(payload), {
          ...p.env,
          PUPPETEER_STATUSLINE_TIMEOUT_MS: '5000',
        }),
      ).resolves.toBe(`${JSON.stringify({ id: 'task-1', content: 'original:task-1' })}\n`);
      await expect(childPayload).resolves.toEqual(payload);
    } finally {
      await bridge.dispose();
    }
  }, 10_000);
});
