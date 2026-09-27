import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnThroughLayout } from './layout.js';
import { materializeShims } from './materialize.js';
import { shellIntegrationEnvironment } from './shell-integration.js';

const zsh = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'].find(
  (candidate) => spawnSync(candidate, ['-fc', 'exit 0']).status === 0,
);

describe('shellIntegrationEnvironment', () => {
  const home = '/hosts/shim-home';
  const { shimDirectory, zshDirectory } = spawnThroughLayout(home);

  it('points a zsh at the integration and hands it the ZDOTDIR to give back', () => {
    expect(shellIntegrationEnvironment({ home, shell: '/bin/zsh', environment: { ZDOTDIR: '/me/zdot' } })).toEqual({
      ZDOTDIR: zshDirectory,
      PUPPETEER_ORIGINAL_ZDOTDIR: '/me/zdot',
      PUPPETEER_SHIM_DIR: shimDirectory,
    });
    expect(shellIntegrationEnvironment({ home, shell: '-zsh', environment: {} })).toEqual({
      ZDOTDIR: zshDirectory,
      PUPPETEER_ORIGINAL_ZDOTDIR: '',
      PUPPETEER_SHIM_DIR: shimDirectory,
    });
    // An environment already pointed at the integration has no original of its own.
    expect(
      shellIntegrationEnvironment({ home, shell: 'zsh', environment: { ZDOTDIR: `${zshDirectory}/` } })
        .PUPPETEER_ORIGINAL_ZDOTDIR,
    ).toBe('');
  });

  it('puts the shim directory first, once, on the PATH of any other shell (best effort)', () => {
    expect(
      shellIntegrationEnvironment({
        home,
        shell: '/bin/bash',
        environment: { PATH: ['/usr/bin', shimDirectory, '/bin'].join(delimiter) },
      }),
    ).toEqual({ PUPPETEER_SHIM_DIR: shimDirectory, PATH: [shimDirectory, '/usr/bin', '/bin'].join(delimiter) });
    // Never an empty entry (the current directory) where there was none.
    expect(shellIntegrationEnvironment({ home, shell: 'fish', environment: {} }).PATH).toBe(shimDirectory);
  });
});

describe.skipIf(!zsh)(`the zsh integration, in a real zsh (${zsh ?? 'zsh is not installed: skipped'})`, () => {
  let root: string;
  let person: string;
  let personZdot: string;
  let realBin: string;
  let home: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pst-'));
    // A throwaway person: HOME and ZDOTDIR are set for every child, so no real startup file is read.
    person = join(root, 'person');
    personZdot = join(root, 'person-zdot');
    realBin = join(root, 'real bin');
    home = join(root, 'shim home');
    for (const directory of [person, personZdot, realBin]) await mkdir(directory);
    for (const [directory, mark] of [
      [person, 'home'],
      [personZdot, 'zdot'],
    ] as const) {
      await writeFile(join(directory, '.zshenv'), `export MARK_ZSHENV=${mark}\n`);
      await writeFile(
        join(directory, '.zshrc'),
        [
          `MARK_ZSHRC=${mark}`,
          // What a profile does: other directories ahead, the shim directory repeated behind.
          'path=(/opt/first "$PUPPETEER_SHIM_DIR" /usr/local/bin $path "$PUPPETEER_SHIM_DIR")',
          // macOS's /etc/zshrc line.
          'HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history',
          '',
        ].join('\n'),
      );
    }
    await writeFile(join(realBin, 'example'), '#!/bin/sh\necho real\n');
    await chmod(join(realBin, 'example'), 0o755);
    const script = join(root, 'agent-shim.cjs');
    await writeFile(script, '// the bundled shim\n');
    await materializeShims({ home, names: ['example'], script, runtime: { command: process.execPath } });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function run(args: string[], options: { zdotdir?: string; input?: string } = {}) {
    const base = {
      HOME: person,
      PATH: '/usr/bin:/bin',
      ...(options.zdotdir === undefined ? {} : { ZDOTDIR: options.zdotdir }),
    };
    const result = spawnSync(zsh!, args, {
      encoding: 'utf8',
      env: { ...base, ...shellIntegrationEnvironment({ home, shell: zsh!, environment: base }) },
      input: options.input ?? '',
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  const report = 'print -r -- "ZDOTDIR=${ZDOTDIR-<unset>}|ENV=$MARK_ZSHENV|RC=${MARK_ZSHRC-}|HIST=${HISTFILE-}"';

  it('gives ZDOTDIR back first: unset when there was none, and the startup files are the person’s', () => {
    const result = run(['-i', '-c', report]);
    expect(result.stdout.trim()).toBe(`ZDOTDIR=<unset>|ENV=home|RC=home|HIST=${join(person, '.zsh_history')}`);
    expect(run(['-c', 'print -r -- "${PUPPETEER_ORIGINAL_ZDOTDIR-<unset>}"']).stdout.trim()).toBe('<unset>');
  });

  it('gives back the original ZDOTDIR when there was one, and reads its files', () => {
    const result = run(['-i', '-c', report], { zdotdir: personZdot });
    expect(result.stdout.trim()).toBe(
      `ZDOTDIR=${personZdot}|ENV=zdot|RC=zdot|HIST=${join(personZdot, '.zsh_history')}`,
    );
    // History is the person's, never under the shim home.
    expect(result.stdout).not.toContain(home);
  });

  it('registers the hook in an interactive shell; it puts the shim directory first, once', () => {
    const { shimDirectory } = spawnThroughLayout(home);
    const result = run([
      '-i',
      '-c',
      [
        'print -r -- "hooked=${precmd_functions[(I)_puppeteer_shim_path]}"',
        'print -r -- "before=${(j.|.)path}"',
        '_puppeteer_shim_path',
        'print -r -- "after=${(j.|.)path}"',
        // First already, but repeated behind: still rewritten to once.
        'path+=("$PUPPETEER_SHIM_DIR")',
        '_puppeteer_shim_path',
        'print -r -- "again=${(j.|.)path}"',
      ].join('; '),
    ]);
    const [hooked, before, after, again] = result.stdout.trimEnd().split('\n');
    expect(hooked).not.toBe('hooked=0');
    const startup = before!.slice('before='.length).split('|');
    // The person's startup files ran first: another directory ahead, the shim directory twice.
    expect(startup[0]).toBe('/opt/first');
    expect(startup.filter((entry) => entry === shimDirectory)).toHaveLength(2);
    const expected = [shimDirectory, ...startup.filter((entry) => entry !== shimDirectory)];
    expect(after!.slice('after='.length).split('|')).toEqual(expected);
    expect(again!.slice('again='.length).split('|')).toEqual(expected);
  });

  it('never sources itself when ZDOTDIR still names the integration', () => {
    const { shimDirectory, zshDirectory } = spawnThroughLayout(home);
    const result = spawnSync(zsh!, ['-c', 'print -r -- ok'], {
      encoding: 'utf8',
      env: { HOME: person, PATH: '/usr/bin:/bin', ZDOTDIR: zshDirectory, PUPPETEER_SHIM_DIR: shimDirectory },
      timeout: 15_000,
    });
    expect(result.stdout.trim()).toBe('ok');
    expect(result.stderr).toBe('');
  });

  it('registers nothing in a non-interactive zsh -c', () => {
    const result = run(['-c', 'print -r -- "fn=${+functions[_puppeteer_shim_path]}|hooks=${#precmd_functions}"']);
    expect(result.stdout.trim()).toBe('fn=0|hooks=0');
  });

  it('resolves the name to the launcher at the first prompt, and again after PATH is reordered', () => {
    const { shimDirectory } = spawnThroughLayout(home);
    // An interactive zsh reading from a pipe still runs precmd before each prompt.
    const result = run(['-i'], {
      input: [
        'whence -p example',
        `export PATH=${JSON.stringify(realBin)}:$PATH`,
        'whence -p example',
        'unset PUPPETEER_SHIM_DIR',
        `export PATH=${JSON.stringify(realBin)}:$PATH`,
        'whence -p example',
        'exit',
        '',
      ].join('\n'),
    });
    expect(result.stdout.trim().split('\n')).toEqual([
      join(shimDirectory, 'example'),
      join(shimDirectory, 'example'),
      // A person can leave: with the variable gone, the hook stands aside.
      join(realBin, 'example'),
    ]);
  });
});
