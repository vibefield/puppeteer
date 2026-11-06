import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCapabilityError,
  createClaudeLaunchPreflight,
  detectClaude,
  identifyClaudeExecutable,
  requiredClaudeLaunchCapabilities,
  type ClaudeExec,
} from './detection.js';
import { CLAUDE_SURFACE_VERSION } from './generated/registry.js';
import { isolatedClaudeExec, requireClaudeLiveExecutable } from './test-support/live-executable.js';
import { isolatedClaudeLiveEnvironment, startClaudeLoopbackProvider } from './test-support/live-model.js';

const FULL_HELP = `Usage: claude [options] [prompt]

Options:
  --session-id <uuid>         Use a specific session ID (must be a valid UUID)
  -n, --name <name>           Name the session
  --settings <file-or-json>   Path to a settings JSON file or a JSON string
  --setting-sources <sources> Comma-separated setting sources
  --permission-mode <mode>    Permission mode to use (default: "default")
  -r, --resume [value]        Resume a conversation by session ID
  --model <model>             Model for the current session
  --effort <level>            Effort level for the current session
  -p, --print                 Print response and exit (structured mode)
  --mcp-config <configs...>   Run MCP servers
  --allowedTools <tools...>   Allow tools
  --append-system-prompt-file <file> Append instructions
  --system-prompt-snapshot <on|off> Snapshot policy
  -h, --help                  Display help`;

/** Fake exec: routes on the probed subcommand, with per-call failure hooks. */
function fakeExec(
  opts: { version?: string; help?: string; failVersion?: boolean; failHelp?: boolean } = {},
): ClaudeExec {
  return async (_file, args) => {
    if (args.includes('--version')) {
      if (opts.failVersion) throw new Error('spawn ENOENT');
      return { stdout: opts.version ?? `${CLAUDE_SURFACE_VERSION} (Claude Code)` };
    }
    if (opts.failHelp) throw new Error('spawn ENOENT');
    return { stdout: opts.help ?? FULL_HELP };
  };
}

describe('detectClaude', () => {
  it('all flags present → parsed version, all flags true, no warnings', async () => {
    const result = await detectClaude({ executable: 'claude', exec: fakeExec() });
    expect(result.version).toBe(CLAUDE_SURFACE_VERSION);
    expect(result.flags).toEqual({
      sessionId: true,
      settings: true,
      settingSources: true,
      name: true,
      permissionMode: true,
      resume: true,
      model: true,
      effort: true,
      mcpServers: true,
      allowTools: true,
      appendSystemPromptFile: true,
      systemPromptSnapshot: true,
    });
    expect(result.warnings).toEqual([]);
  });

  it('recognizes the short -n form for --name', async () => {
    const help = FULL_HELP.replace(/^.*--name.*$/m, '  -n <name>                   Name the session');
    const result = await detectClaude({ exec: fakeExec({ help }) });
    expect(result.flags.name).toBe(true);
  });

  it('missing --session-id → flags.sessionId false + a warning', async () => {
    const help = FULL_HELP.split('\n')
      .filter((line) => !line.includes('--session-id'))
      .join('\n');
    const result = await detectClaude({ exec: fakeExec({ help }) });
    expect(result.flags.sessionId).toBe(false);
    expect(result.flags.settings).toBe(true);
    expect(result.warnings.some((w) => w.includes('--session-id'))).toBe(true);
  });

  it('unparseable version → warning, version undefined, flags still probed', async () => {
    const result = await detectClaude({ exec: fakeExec({ version: 'claude code (dev build)' }) });
    expect(result.version).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('could not parse version'))).toBe(true);
    expect(result.flags.settings).toBe(true);
  });

  it('does not throw when the binary cannot be run; degrades to all-false flags', async () => {
    const result = await detectClaude({ exec: fakeExec({ failVersion: true, failHelp: true }) });
    expect(result.version).toBeUndefined();
    expect(result.flags).toEqual({
      sessionId: false,
      settings: false,
      settingSources: false,
      name: false,
      permissionMode: false,
      resume: false,
      model: false,
      effort: false,
      mcpServers: false,
      allowTools: false,
      appendSystemPromptFile: false,
      systemPromptSnapshot: false,
    });
    // one --version failure + one --help failure + missing-flag warnings
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('checks only the flags used by the concrete launch recipe', () => {
    expect(requiredClaudeLaunchCapabilities({ freshSession: true })).toEqual([
      'settings',
      'permissionMode',
      'sessionId',
    ]);
    expect(
      requiredClaudeLaunchCapabilities({
        freshSession: false,
        resume: true,
        title: true,
        model: true,
        effort: true,
        settingSources: true,
      }),
    ).toEqual(['settings', 'permissionMode', 'resume', 'name', 'model', 'effort', 'settingSources']);
  });

  it('fails preflight with a typed capability error before launch', async () => {
    const help = FULL_HELP.split('\n')
      .filter((line) => !line.includes('--model'))
      .join('\n');
    const preflight = createClaudeLaunchPreflight(fakeExec({ help }));

    await expect(preflight({ executable: '/opt/claude', freshSession: true, model: true })).rejects.toMatchObject({
      name: 'ClaudeCapabilityError',
      code: 'CLAUDE_CAPABILITY_MISSING',
      missingFlags: ['model'],
    } satisfies Partial<ClaudeCapabilityError>);
  });

  it('caches version/help detection per executable while reevaluating launch requirements', async () => {
    let calls = 0;
    const exec = fakeExec();
    const preflight = createClaudeLaunchPreflight(
      async (file, args) => {
        calls += 1;
        return exec(file, args);
      },
      { identify: async () => 'claude@1' },
    );

    await preflight({ executable: '/opt/claude', freshSession: true });
    await preflight({ executable: '/opt/claude', freshSession: false, resume: true, model: true });
    expect(calls).toBe(2); // one --version and one --help probe
  });

  it('probes again after a failed probe and after the file changes, never twice for the same file', async () => {
    const calls: string[] = [];
    let identity = 'claude@1';
    let version: string = CLAUDE_SURFACE_VERSION;
    let helpFails = true;
    const preflight = createClaudeLaunchPreflight(
      async (file, args) => {
        calls.push(args.join(' '));
        if (args.includes('--help') && helpFails) {
          helpFails = false;
          throw new Error('Command failed: claude --help (timed out)');
        }
        return fakeExec({ version: `${version} (Claude Code)` })(file, args);
      },
      { identify: async () => identity },
    );
    const launch = { executable: '/opt/claude', freshSession: true };

    // A probe that failed is an observation, not a fact about the file: that launch is refused, the next probes again.
    await expect(preflight(launch)).rejects.toBeInstanceOf(ClaudeCapabilityError);
    await expect(preflight(launch)).resolves.toMatchObject({ version: CLAUDE_SURFACE_VERSION });
    expect(calls.filter((call) => call === '--help')).toHaveLength(2);
    // A complete probe is the file's: the same identity never execs again.
    await preflight(launch);
    expect(calls).toHaveLength(4);

    // An in-place update (the launcher re-pointed, the entry rewritten) is a new identity.
    identity = 'claude@2';
    version = '9.9.9';
    await expect(preflight(launch)).resolves.toMatchObject({ version: '9.9.9' });
    expect(calls).toHaveLength(6);
  });

  it('shares one in-flight probe between concurrent launches and forgets it once it settles incomplete', async () => {
    let calls = 0;
    const exec = fakeExec({ failVersion: true });
    const preflight = createClaudeLaunchPreflight(
      async (file, args) => {
        calls += 1;
        return exec(file, args);
      },
      { identify: async () => 'claude@1' },
    );
    const launch = { executable: '/opt/claude', freshSession: true };

    const [first, second] = await Promise.all([preflight(launch), preflight(launch)]);
    expect(second).toBe(first);
    expect(calls).toBe(2);
    // No version was read, so the detection was incomplete: the next launch probes again.
    await preflight(launch);
    expect(calls).toBe(4);
  });

  it('probes every launch of an executable it cannot identify', async () => {
    let calls = 0;
    const identified: string[] = [];
    const exec = fakeExec();
    const preflight = createClaudeLaunchPreflight(
      async (file, args) => {
        calls += 1;
        return exec(file, args);
      },
      {
        identify: async (executable) => {
          identified.push(executable);
          return undefined;
        },
      },
    );

    await preflight({ executable: '/opt/claude', freshSession: true });
    await preflight({ executable: '/opt/claude', freshSession: true });
    expect(identified).toEqual(['/opt/claude', '/opt/claude']);
    expect(calls).toBe(4);
  });

  it('resolution order: explicit executable wins over the env override', async () => {
    const prev = process.env.PUPPETEER_CLAUDE_BIN;
    process.env.PUPPETEER_CLAUDE_BIN = '/env/claude';
    try {
      const explicit = await detectClaude({ executable: '/opt/claude', exec: fakeExec() });
      expect(explicit.executable).toBe('/opt/claude');
      const fromEnv = await detectClaude({ exec: fakeExec() });
      expect(fromEnv.executable).toBe('/env/claude');
    } finally {
      if (prev === undefined) delete process.env.PUPPETEER_CLAUDE_BIN;
      else process.env.PUPPETEER_CLAUDE_BIN = prev;
    }
  });
});

describe('identifyClaudeExecutable', () => {
  // The file execFile finds for a bare `claude`: libuv appends `.exe` on Windows (it reads no PATHEXT).
  const fileName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const tempRoot = () => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-claude-identify-')));

  it('keys the file a bare name or a path runs, and moves when that file changes', async () => {
    const root = tempRoot();
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const file = join(bin, fileName);
      writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });

      const identity = await identifyClaudeExecutable(file);
      expect(identity).toBeDefined();
      expect(await identifyClaudeExecutable('claude', { PATH: bin })).toBe(identity);
      expect(await identifyClaudeExecutable('claude', { PATH: join(root, 'elsewhere') })).toBeUndefined();
      expect(await identifyClaudeExecutable(join(bin, 'absent'))).toBeUndefined();

      utimesSync(file, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
      const touched = await identifyClaudeExecutable(file);
      expect(touched).toBeDefined();
      expect(touched).not.toBe(identity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keys a script by the one file its runner reads, with no execute bit and no PATH lookup', async () => {
    const root = tempRoot();
    try {
      // The default exec runs a script as `<runner> <script>`: the runner opens the name as a path, so the file needs
      // no execute bit, and a bare name is the working directory's file, never one on PATH.
      const script = join(root, 'ai.mjs');
      writeFileSync(script, 'export {};\n', { mode: 0o644 });

      const identity = await identifyClaudeExecutable(script);
      expect(identity).toBeDefined();
      expect(await identifyClaudeExecutable(script)).toBe(identity);
      expect(await identifyClaudeExecutable('ai.mjs', { PATH: root })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'follows PATH as execvp does and moves when the launcher symlink is re-pointed',
    async () => {
      const root = tempRoot();
      try {
        const versions = join(root, 'versions');
        mkdirSync(versions);
        for (const version of ['1.0.0', '1.0.1']) {
          writeFileSync(join(versions, version), '#!/bin/sh\n', { mode: 0o755 });
        }
        // A `claude` without the execute bit earlier on PATH is passed over, as execvp passes over it.
        const shadow = join(root, 'shadow');
        mkdirSync(shadow);
        writeFileSync(join(shadow, 'claude'), '#!/bin/sh\n', { mode: 0o644 });
        const bin = join(root, 'bin');
        mkdirSync(bin);
        const launcher = join(bin, 'claude');
        symlinkSync(join(versions, '1.0.0'), launcher);
        const environment = { PATH: [shadow, bin].join(delimiter) };

        const before = await identifyClaudeExecutable('claude', environment);
        expect(before).toBeDefined();
        expect(before).toBe(await identifyClaudeExecutable(join(versions, '1.0.0')));

        // The native installer's update: a new version, the launcher swapped onto it in one rename.
        symlinkSync(join(versions, '1.0.1'), `${launcher}.next`);
        renameSync(`${launcher}.next`, launcher);
        const after = await identifyClaudeExecutable('claude', environment);
        expect(after).toBeDefined();
        expect(after).not.toBe(before);
        expect(after).toBe(await identifyClaudeExecutable(join(versions, '1.0.1')));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

// Opt-in: probes the explicitly named artifact (never `claude` on PATH) with isolated user state.
const realClaude = process.env.CLAUDE_NATIVE_TUI_LIVE === '1';
describe.skipIf(!realClaude)('detectClaude against the real binary', () => {
  it('is the exact Surface candidate and reports the required flags', async () => {
    const executable = requireClaudeLiveExecutable();
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-claude-detect-')));
    const cwd = join(root, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const provider = await startClaudeLoopbackProvider();
    let result: Awaited<ReturnType<typeof detectClaude>>;
    try {
      const environment = isolatedClaudeLiveEnvironment(root, join(root, 'claude-config'), cwd, provider.baseUrl);
      result = await detectClaude({ executable, exec: isolatedClaudeExec(environment) });
    } finally {
      await provider.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
    expect(result.executable).toBe(executable);
    expect(result.version).toBe(CLAUDE_SURFACE_VERSION);
    expect(result.flags).toEqual({
      sessionId: true,
      settings: true,
      settingSources: true,
      name: true,
      permissionMode: true,
      resume: true,
      model: true,
      effort: true,
      mcpServers: true,
      allowTools: true,
      appendSystemPromptFile: true,
      systemPromptSnapshot: true,
    });
    expect(result.warnings).toEqual([]);
  }, 30_000);
});

it('refuses instructions on a Claude version that would reuse its saved prompt, but permits ordinary launches', async () => {
  const preflight = createClaudeLaunchPreflight(
    fakeExec({ help: FULL_HELP.replace(/^.*--system-prompt-snapshot.*$/m, '') }),
  );
  await expect(preflight({ freshSession: false, resume: true, instructions: true })).rejects.toMatchObject({
    code: 'UNSUPPORTED_LAUNCH_FIELD',
    message: expect.stringContaining('instructions'),
  });
  await expect(preflight({ freshSession: false, resume: true })).resolves.toBeDefined();
});
