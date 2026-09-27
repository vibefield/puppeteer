import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnThroughLayout } from './layout.js';
import { launcherScript, materializeShims, shellQuote } from './materialize.js';
import { ZSH_INTEGRATION } from './shell-integration.js';

let root: string;
let home: string;
let script: string;
let runtime: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pst-'));
  // A host's home is often under "Application Support"; a quote is the harder case.
  home = join(root, "it's a home");
  script = join(root, 'agent-shim.cjs');
  await writeFile(script, '// the bundled shim\n');
  // A stub "runtime": prints what the launcher handed it, one item per line.
  runtime = join(root, "run time's", 'node');
  await mkdir(join(root, "run time's"));
  await writeFile(
    runtime,
    [
      '#!/bin/sh',
      'for argument in "$@"; do printf "arg:%s\\n" "$argument"; done',
      'printf "pid:%s\\n" "$$"',
      'env | grep -E "^(PUPPETEER_|STUB_)" | sort | sed "s/^/env:/"',
      '',
    ].join('\n'),
  );
  await chmod(runtime, 0o755);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const status = await stat(path);
    files[relative(directory, path)] =
      `${status.ino}:${status.mtimeMs}:${status.mode}:${(await readFile(path)).toString('base64')}`;
  }
  return files;
}

describe('materializeShims', () => {
  it('writes launchers that quote every path and value for sh — proved by running one', async () => {
    const odd = `it's "quoted" $HOME \`not run\` \\ and *`;
    const result = await materializeShims({
      home,
      names: ['example'],
      script,
      runtime: { command: runtime, args: ['--first', "sec'ond arg"], env: { STUB_ODD: odd, STUB_EMPTY: '' } },
    });
    const layout = spawnThroughLayout(home);
    expect(result).toEqual({ shimDirectory: layout.shimDirectory, names: ['example'] });

    const run = spawnSync(join(layout.shimDirectory, 'example'), ['one two', "th'ree", '*', ''], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', PUPPETEER_SHIM_STRICT: '1' },
    });
    expect(run.status).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines.filter((line) => line.startsWith('arg:'))).toEqual([
      'arg:--first',
      "arg:sec'ond arg",
      `arg:${layout.script}`,
      'arg:one two',
      "arg:th'ree",
      'arg:*',
      'arg:',
    ]);
    expect(lines.filter((line) => line.startsWith('env:'))).toEqual(
      [
        `env:PUPPETEER_SHIM_HOME=${home}`,
        'env:PUPPETEER_SHIM_NAME=example',
        // The launcher's own say, not an inherited one.
        'env:PUPPETEER_SHIM_STRICT=0',
        'env:PUPPETEER_SHIM_STRIP=STUB_ODD STUB_EMPTY',
        'env:STUB_EMPTY=',
        `env:STUB_ODD=${odd}`,
      ].sort(),
    );
  });

  it('owns the whole home, owner-only, with the integration and the shim beside the launchers', async () => {
    await materializeShims({ home, names: ['example', 'other'], script, runtime: { command: runtime } });
    const layout = spawnThroughLayout(home);
    for (const directory of [home, layout.shimDirectory, join(home, 'lib'), layout.zshDirectory]) {
      expect(await modeOf(directory), directory).toBe(0o700);
    }
    for (const name of ['example', 'other']) expect(await modeOf(join(layout.shimDirectory, name))).toBe(0o700);
    expect(await modeOf(layout.script)).toBe(0o600);
    expect(await modeOf(layout.zshenv)).toBe(0o600);
    expect(await readFile(layout.script, 'utf8')).toBe('// the bundled shim\n');
    expect(await readFile(layout.zshenv, 'utf8')).toBe(ZSH_INTEGRATION);
    expect(await readFile(join(layout.shimDirectory, 'example'), 'utf8')).toBe(
      launcherScript({ name: 'example', home, runtime: { command: runtime } }),
    );
  });

  it('removes the launcher of a name no longer asked for', async () => {
    await materializeShims({ home, names: ['alpha', 'beta'], script, runtime: { command: runtime } });
    const result = await materializeShims({
      home,
      names: ['gamma', 'beta', 'beta'],
      script,
      runtime: { command: runtime },
    });
    expect(result.names).toEqual(['beta', 'gamma']);
    expect((await readdir(spawnThroughLayout(home).shimDirectory)).sort()).toEqual(['beta', 'gamma']);
    await materializeShims({ home, names: [], script, runtime: { command: runtime } });
    expect(await readdir(spawnThroughLayout(home).shimDirectory)).toEqual([]);
  });

  it('is idempotent: an identical second call rewrites no file', async () => {
    const options = { home, names: ['example', 'other'], script, runtime: { command: runtime, args: ['--x'] } };
    await materializeShims(options);
    const before = await snapshot(home);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await materializeShims(options);
    expect(await snapshot(home)).toEqual(before);
    expect(Object.keys(before).sort()).toEqual(
      ['bin/example', 'bin/other', 'lib/agent-shim.cjs', 'zsh/.zshenv'].sort(),
    );

    // A changed runtime is a changed launcher.
    await materializeShims({ ...options, runtime: { command: runtime, args: ['--y'] } });
    expect((await snapshot(home))['bin/example']).not.toBe(before['bin/example']);
  });

  it("writes the strict launcher's say", async () => {
    await materializeShims({ home, names: ['example'], script, runtime: { command: runtime }, strict: true });
    const run = spawnSync(join(spawnThroughLayout(home).shimDirectory, 'example'), [], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(run.stdout).toContain('env:PUPPETEER_SHIM_STRICT=1\n');
  });

  it('refuses a name or a runtime a launcher cannot be written for, and writes nothing', async () => {
    for (const name of ['', 'a b', '../x', '-x', '.hidden', "it's", 'a;b', 'x'.repeat(129), 'new\nline']) {
      await expect(
        materializeShims({ home, names: [name], script, runtime: { command: runtime } }),
        JSON.stringify(name),
      ).rejects.toThrow(/not a command name/u);
    }
    for (const runtimeOptions of [
      { command: 'node' },
      { command: runtime, env: { 'BAD NAME': '1' } },
      { command: runtime, env: { PATH: '/usr/bin' } },
      { command: runtime, env: { PUPPETEER_SHIM_NAME: 'x' } },
    ]) {
      await expect(
        materializeShims({ home, names: ['example'], script, runtime: runtimeOptions }),
        JSON.stringify(runtimeOptions),
      ).rejects.toThrow();
    }
    await expect(
      materializeShims({ home: 'relative/home', names: ['example'], script, runtime: { command: runtime } }),
    ).rejects.toThrow(/absolute/u);
    await expect(stat(home)).rejects.toThrow();
  });

  it('quotes a word for sh', () => {
    expect(shellQuote('')).toBe("''");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    const run = spawnSync('/bin/sh', ['-c', `printf %s ${shellQuote('a\'b "c" $d `e`')}`], { encoding: 'utf8' });
    expect(run.stdout).toBe('a\'b "c" $d `e`');
  });
});
