import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupClaudeSession,
  prepareClaudeSession,
  statusLineForwarderCommand,
  type PreparedClaudeSession,
} from './prepare.js';
import { generateHookSettings } from './settings.js';
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
  tokenEnvVar: 'CHOPSTICKS_HOOK_TOKEN',
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

  it('reuses a caller-supplied session id (the spaghetti join contract)', async () => {
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
    expect(text).toContain('$CHOPSTICKS_HOOK_TOKEN');
    expect(readFileSync(p.hookForwarderPath, 'utf8')).not.toContain(BASE.token);
    expect(p.env).toEqual({ CHOPSTICKS_HOOK_TOKEN: BASE.token });
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
      const handler = settings.hooks.SessionStart[0].hooks[0];
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
      expect(p.env.CHOPSTICKS_STATUSLINE_DELEGATE).toBe('project-line');
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
      expect(p.env.CHOPSTICKS_STATUSLINE_DELEGATE).toBe('relocated-user-line');
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

  it('resume uses --resume with the resumed id and NEVER --session-id (mutually exclusive)', async () => {
    const resumeId = '64a61b19-f4d8-4f96-ba56-07024b470813';
    const p = await prepare({ resume: resumeId });
    expect(p.sessionId).toBe(resumeId); // join contract preserved: same id
    expect(p.args).toContain('--resume');
    expect(p.args[p.args.indexOf('--resume') + 1]).toBe(resumeId);
    expect(p.args).not.toContain('--session-id');
    // Settings still attach on resume (the hook bridge follows a resumed session).
    expect(p.args).toContain('--settings');
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
      CHOPSTICKS_STATUSLINE_ENDPOINT: 'http://127.0.0.1:1/statusline',
      CHOPSTICKS_STATUSLINE_DELEGATE: delegate,
      CHOPSTICKS_STATUSLINE_TOKEN_ENV_VAR: BASE.tokenEnvVar,
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
    const childPayloads: unknown[] = [];
    bridge.onSubagentStatusLine((envelope) => childPayloads.push(envelope.body));
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
      await expect(runStatusLine(settings.subagentStatusLine.command, JSON.stringify(payload), p.env)).resolves.toBe(
        `${JSON.stringify({ id: 'task-1', content: 'original:task-1' })}\n`,
      );
      expect(childPayloads).toEqual([payload]);
    } finally {
      await bridge.dispose();
    }
  });
});
