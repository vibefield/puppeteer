/**
 * The opt-in live tests run the exact artifact they are given, in a throwaway profile. One that resolved
 * `codex` the production way would fall back to the developer's own install on PATH and its real
 * `~/.codex` (test-support/live-profile.ts).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_LIVE_API_KEY,
  CODEX_LIVE_PINNED_VARIABLES,
  isolatedCodexLiveEnvironment,
} from './test-support/live-model.js';
import {
  createCodexLiveProfile,
  inheritedCodexVariables,
  removeCodexLiveRoot,
  requireCodexLiveExecutable,
} from './test-support/live-profile.js';

const source = dirname(fileURLToPath(import.meta.url));

/** The live tests under `directory`, named from it with `/` on every platform (Windows CI included). */
function liveTests(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return liveTests(join(directory, entry.name), `${name}/`);
    return entry.name.endsWith('.live.test.ts') ? [name] : [];
  });
}

/**
 * What a call that can start codex must be given to keep it in the throwaway profile. Without `env`, an
 * app-server, a usage or model probe, or a terminal inherits this process's HOME and so the developer's
 * `~/.codex`; without `transport`, a session spawns its own app-server that way; a TUI session needs
 * both its terminal's and its app-server's environment.
 */
const ISOLATING_OPTIONS = new Map<string, readonly string[]>([
  ['spawnAppServer', ['env']],
  ['spawnAppServerTransport', ['env']],
  ['createCodexSession', ['transport']],
  ['createCodexTuiSession', ['env', 'appServerEnv']],
  ['prepareCodexTuiSession', ['env', 'appServerEnv']],
  ['fetchCodexAccountUsage', ['env']],
  ['fetchCodexAccountUsageForProfile', ['env']],
  ['createCodexAccountUsageService', ['env']],
  ['createCodexModelService', ['env']],
  ['spawnTerminal', ['env']],
]);

/**
 * Each call in `text` to one of the functions above that leaves out an option it needs, as
 * `callee: option`. A heuristic over the source text, by balanced parentheses: an object-literal
 * argument must name the option, a call with no argument at all is reported, a method definition
 * (`async spawnTerminal() {`) is not a call, and any other argument (`prepared.launch`) is a value built
 * elsewhere and is not followed. Whether the option's value is the profile's is left to review.
 */
function unisolatedCalls(text: string): string[] {
  const missing: string[] = [];
  for (const match of text.matchAll(/\b([A-Za-z]+)\(/gu)) {
    const callee = match[1]!;
    const options = ISOLATING_OPTIONS.get(callee);
    if (!options) continue;
    const start = match.index + match[0].length;
    let end = start;
    for (let depth = 1; end < text.length && depth > 0; end += 1) {
      if (text[end] === '(') depth += 1;
      else if (text[end] === ')') depth -= 1;
    }
    if (/^\s*\{/u.test(text.slice(end)) && /(?:async|function)\s+$/u.test(text.slice(0, match.index))) continue;
    const argument = text.slice(start, end - 1).trim();
    if (argument !== '' && !argument.startsWith('{')) continue;
    for (const option of options) {
      if (!new RegExp(`(?:^|[{,\\s])${option}\\s*[:,}]`, 'u').test(argument)) missing.push(`${callee}: ${option}`);
    }
  }
  return missing;
}

describe('requireCodexLiveExecutable', () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('refuses to run without an explicitly named codex', () => {
    expect(() => requireCodexLiveExecutable('CODEX_LIVE', {})).toThrow(
      'CODEX_LIVE=1 runs only the Codex named by PUPPETEER_CODEX_BIN=/absolute/path/to/codex, never one from PATH: ' +
        'PUPPETEER_CODEX_BIN is not set',
    );
    expect(() => requireCodexLiveExecutable('CODEX_LIVE', { PUPPETEER_CODEX_BIN: '' })).toThrow(/is not set$/u);
  });

  it('refuses a bare name, which spawn would look up on PATH', () => {
    expect(() => requireCodexLiveExecutable('CODEX_LIVE', { PUPPETEER_CODEX_BIN: 'codex' })).toThrow(
      /PUPPETEER_CODEX_BIN is not an absolute path$/u,
    );
  });

  it('refuses a path that names no file', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-live-bin-')));
    scratch.push(directory);
    for (const path of [join(directory, 'codex'), directory]) {
      expect(() => requireCodexLiveExecutable('CODEX_LIVE', { PUPPETEER_CODEX_BIN: path })).toThrow(
        /PUPPETEER_CODEX_BIN names no file$/u,
      );
    }
  });

  it('returns the file it names', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-live-bin-')));
    scratch.push(directory);
    const executable = join(directory, 'codex');
    writeFileSync(executable, '');
    expect(requireCodexLiveExecutable('CODEX_LIVE', { PUPPETEER_CODEX_BIN: executable })).toBe(executable);
  });

  it('refuses an environment exporting Codex credentials or state the profile does not pin', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'codex-live-bin-')));
    scratch.push(directory);
    const executable = join(directory, 'codex');
    writeFileSync(executable, '');
    // Placeholders: the message names the variables, never their values.
    const environment = {
      PUPPETEER_CODEX_BIN: executable,
      CODEX_ACCESS_TOKEN: 'placeholder-token',
      CODEX_ROLLOUT_TRACE_ROOT: '/elsewhere',
    };
    expect(() => requireCodexLiveExecutable('CODEX_LIVE', environment)).toThrow(
      'CODEX_LIVE=1 runs codex only in a throwaway profile, but this environment exports ' +
        'CODEX_ACCESS_TOKEN, CODEX_ROLLOUT_TRACE_ROOT, which the profile does not pin: unset them',
    );
    expect(() => requireCodexLiveExecutable('CODEX_LIVE', environment)).not.toThrow(/placeholder|elsewhere/u);
  });
});

describe('inheritedCodexVariables', () => {
  it('names what a spawned codex would inherit past the profile, and nothing the profile pins', () => {
    expect(
      inheritedCodexVariables({
        PATH: '/bin',
        CODEX_HOME: '/real/.codex',
        CODEX_SQLITE_HOME: '/real/state',
        OPENAI_API_KEY: 'placeholder',
        OPENAI_BASE_URL: 'https://example.invalid',
        CODEX_LIVE: '1',
        CODEX_NATIVE_TUI_LIVE: '1',
        CODEX_API_KEY: 'placeholder',
        OPENAI_IDENTITY_TOKEN_FILE: '/real/token',
        codex_auth: 'placeholder',
      }),
    ).toEqual(['CODEX_API_KEY', 'OPENAI_IDENTITY_TOKEN_FILE', 'codex_auth']);
  });

  it('pins every Codex and OpenAI variable the profile environment sets', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-live-env-')));
    try {
      const environment = isolatedCodexLiveEnvironment(root, join(root, 'codex-home'));
      expect(
        Object.keys(environment)
          .filter((name) => /^(?:CODEX|OPENAI)_/u.test(name))
          .sort(),
      ).toEqual([...CODEX_LIVE_PINNED_VARIABLES].sort());
      expect(inheritedCodexVariables(environment)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createCodexLiveProfile', () => {
  it('keeps HOME, CODEX_HOME and the temp directories inside one throwaway root', async () => {
    const profile = await createCodexLiveProfile('codex-live-profile-');
    try {
      expect(profile.root.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
      for (const name of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
        expect(profile.environment[name]?.startsWith(profile.root + sep), name).toBe(true);
      }
      expect(profile.environment.CODEX_HOME).toBe(profile.codexHome);
      // 0.164.0 keeps its state, thread-history and log databases under CODEX_SQLITE_HOME when it is
      // set: pinned, so a caller's own value cannot take them outside the profile.
      expect(profile.environment.CODEX_SQLITE_HOME).toBe(profile.codexHome);
      expect(profile.environment.OPENAI_API_KEY).toBe('');
      expect(existsSync(profile.cwd)).toBe(true);
    } finally {
      await profile.dispose();
    }
    expect(existsSync(profile.root)).toBe(false);
  });

  it('configures only the loopback endpoint, with a placeholder key', async () => {
    const profile = await createCodexLiveProfile('codex-live-profile-');
    try {
      expect(profile.provider?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      const config = readFileSync(join(profile.codexHome, 'config.toml'), 'utf8');
      expect(config).toContain(`base_url = "${profile.provider!.baseUrl}/v1"`);
      expect(JSON.parse(readFileSync(join(profile.codexHome, 'auth.json'), 'utf8'))).toEqual({
        OPENAI_API_KEY: CODEX_LIVE_API_KEY,
      });
    } finally {
      await profile.dispose();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'stops what still writes under the profile before removing it, as the plugin sync does',
    async () => {
      const profile = await createCodexLiveProfile('codex-live-profile-', 'none');
      // Like the curated-plugin `git fetch` a killed app-server leaves behind: it names its
      // directory under CODEX_HOME and keeps creating entries there.
      const writer = spawn(
        '/bin/sh',
        ['-c', 'i=0; while :; do i=$((i+1)); mkdir -p "$0/clone/$i/objects"; done', join(profile.codexHome, '.tmp')],
        { stdio: 'ignore' },
      );
      const exited = new Promise((resolve) => writer.once('exit', resolve));
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await profile.dispose();
        expect(existsSync(profile.root)).toBe(false);
        await expect(exited).resolves.toBeDefined();
      } finally {
        writer.kill('SIGKILL');
        rmSync(profile.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      }
    },
  );

  it('leaves a profile without a model empty: no credentials and no provider', async () => {
    const profile = await createCodexLiveProfile('codex-live-profile-', 'none');
    try {
      expect(profile.provider).toBeUndefined();
      expect(readdirSync(profile.codexHome)).toEqual([]);
    } finally {
      await profile.dispose();
    }
  });
});

describe('the opt-in live tests', () => {
  const files = liveTests(source);

  it('are all checked here', () => {
    expect(files.sort()).toEqual([
      'driver.live.test.ts',
      'launch/briefing.live.test.ts',
      'launch/invocation-probe.live.test.ts',
      'launch/models.live.test.ts',
      'native-tui.live.test.ts',
      'observation/observer.live.test.ts',
      'services/account-usage.live.test.ts',
      'transport/ws-transport.live.test.ts',
    ]);
  });

  it.each(files)('%s runs only an explicitly named codex', (file) => {
    const text = readFileSync(join(source, file), 'utf8');
    expect(text).toMatch(/requireCodexLiveExecutable\('[A-Z_]+'\)/u);
    expect(text).not.toMatch(/resolveCodexExecutable|spawnAppServer(?:Transport)?\(\)/u);
  });

  it.each(files)('%s runs in a throwaway HOME and CODEX_HOME', (file) => {
    const text = readFileSync(join(source, file), 'utf8');
    expect(text).toMatch(/createCodexLiveProfile\(|isolatedCodexLiveEnvironment\(/u);
  });

  it.each(files)('%s gives every codex it starts an environment or a transport', (file) => {
    expect(unisolatedCalls(readFileSync(join(source, file), 'utf8'))).toEqual([]);
  });
});

describe('the isolation guard', () => {
  it('reports a call that would start codex under the real HOME', () => {
    expect(
      unisolatedCalls(
        [
          'const profile = await createCodexLiveProfile("p-");',
          'await createCodexSession({ cwd: profile.cwd, model: "m" });',
          'spawnAppServer({ executable });',
          'await fetchCodexAccountUsage({ executable, requestTimeoutMs: 1 });',
          'await createCodexTuiSession({ cwd, executable, host, env: environment });',
          'await host.spawnTerminal({ command: executable, args, cwd });',
          'spawnAppServerTransport();',
        ].join('\n'),
      ),
    ).toEqual([
      'createCodexSession: transport',
      'spawnAppServer: env',
      'fetchCodexAccountUsage: env',
      'createCodexTuiSession: appServerEnv',
      'spawnTerminal: env',
      'spawnAppServerTransport: env',
    ]);
  });

  it('accepts the options given in full, in shorthand, or nested, and skips definitions and built values', () => {
    expect(
      unisolatedCalls(
        [
          'await createCodexSession({ cwd, transport: spawnAppServerTransport({ executable, env: profile.environment }) });',
          'await prepareCodexTuiSession({ cwd, env, appServerEnv: env, host: { async spawnTerminal() { throw 0; } } });',
          'await host.spawnTerminal(prepared.launch);',
          "server = spawnAppServer({ executable, transport: 'websocket', env: environment });",
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('removing a Codex live root', () => {
  // Process discovery and the Windows retry policy are covered in @vibefield/puppeteer-testing/live-cleanup.
  it('removes a root once nothing works under it', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'codex-remove-')));
    writeFileSync(join(root, 'file'), 'x');
    await removeCodexLiveRoot(root);
    expect(existsSync(root)).toBe(false);
  });
});
