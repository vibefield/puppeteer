import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chooseShimRuntime,
  describeShimRuntime,
  firstNodeOnPath,
  nodeCanExecInPlace,
  probeNodeVersion,
} from './shim-runtime.js';

describe('nodeCanExecInPlace', () => {
  it('holds each Node line to the release that brought process.execve', () => {
    for (const version of ['22.15.0', '22.15.1', '22.17.1', '23.11.0', '23.11.1', '24.0.0', '24.18.0', '26.5.0']) {
      expect(nodeCanExecInPlace(version), version).toBe(true);
    }
    // 23.0–23.10 predate it: it came in 23.11.0 and was backported to 22.15.0.
    for (const version of ['22.14.0', '22.14.9', '23.0.0', '23.10.1', '20.19.0', '15.14.0']) {
      expect(nodeCanExecInPlace(version), version).toBe(false);
    }
    expect(nodeCanExecInPlace('24.0.0-rc.1')).toBe(true);
  });

  it('refuses anything process.versions.node would not print', () => {
    for (const version of ['', 'v22.15.0', '22.15', '22', 'twenty-six', ' 26.5.0', '26.5.0\n', '26.5.0 x', 'NaN.1.2']) {
      expect(nodeCanExecInPlace(version), JSON.stringify(version)).toBe(false);
    }
  });
});

// Godview enables spawn-through only on POSIX, where execve and shell launchers exist.
describe.skipIf(process.platform === 'win32')('the node a launcher names', () => {
  let root: string;
  const at = (...parts: string[]): string => join(root, ...parts);
  const electron = { command: '/Applications/Godview.app/Contents/MacOS/Godview', version: '24.18.0' };
  const electronRuntime = { command: electron.command, env: { ELECTRON_RUN_AS_NODE: '1' } };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gv-runtime-'));
    for (const directory of ['empty', 'shim', 'linked', 'plain', 'dir/node', 'real', 'later']) {
      await mkdir(at(directory), { recursive: true });
    }
    for (const directory of ['shim', 'real', 'later']) {
      await writeFile(at(directory, 'node'), '#!/bin/sh\nexit 0\n');
      await chmod(at(directory, 'node'), 0o755);
    }
    await writeFile(at('plain', 'node'), 'not executable\n');
    // The shim directory under other spellings: a link to it, and a link elsewhere to a launcher inside it.
    await symlink(at('shim'), at('shim-link'));
    await symlink(at('shim', 'node'), at('linked', 'node'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is the first executable node on PATH outside the shim directory, under any spelling', () => {
    const path = (...directories: string[]): string => directories.map((directory) => at(directory)).join(delimiter);
    expect(firstNodeOnPath(path('empty', 'shim', 'real', 'later'), [at('shim')])).toBe(at('real', 'node'));
    expect(
      firstNodeOnPath([at('shim-link'), `${at('shim')}/`, at('linked'), at('later')].join(delimiter), [at('shim')]),
    ).toBe(at('later', 'node'));
    // Not executable, or not a file: the next entry.
    expect(firstNodeOnPath(path('plain', 'dir', 'later'), [])).toBe(at('later', 'node'));
    // An entry relative to Godview's cwd is named absolutely.
    expect(firstNodeOnPath(relative(process.cwd(), at('real')), [undefined])).toBe(at('real', 'node'));
    expect(firstNodeOnPath(path('empty', 'shim'), [at('shim')])).toBeUndefined();
    expect(firstNodeOnPath('', [])).toBeUndefined();
  });

  it('is chosen when it can exec in place, probed once, with no variable of Electron’s', async () => {
    const probe = vi.fn(async () => '26.5.0');
    const choice = await chooseShimRuntime({
      path: [at('empty'), at('real'), at('later')].join(delimiter),
      shimDirectories: [at('shim')],
      electron,
      probe,
    });
    expect(choice).toEqual({
      kind: 'node',
      runtime: { command: at('real', 'node') },
      command: at('real', 'node'),
      version: '26.5.0',
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(at('real', 'node'));
    expect(describeShimRuntime(choice)).toBe(`spawn-through runtime: node 26.5.0 at ${at('real', 'node')}`);
  });

  it('falls back to Godview’s own binary as node when the first node cannot, cannot say, or is absent', async () => {
    const tooOld = await chooseShimRuntime({
      path: at('real'),
      shimDirectories: [],
      electron,
      probe: async () => '22.14.0',
    });
    expect(tooOld).toMatchObject({ kind: 'electron', runtime: electronRuntime, version: '24.18.0' });
    expect(describeShimRuntime(tooOld)).toBe(
      `spawn-through runtime: Godview's own binary as node 24.18.0 at ${electron.command} ` +
        `(node 22.14.0 at ${at('real', 'node')} cannot exec in place)`,
    );
    // The first node decides, as `#!/usr/bin/env node` did: a later one that could is not looked for.
    const first = await chooseShimRuntime({
      path: [at('real'), at('later')].join(delimiter),
      shimDirectories: [],
      electron,
      probe: async (command) => (command === at('later', 'node') ? '26.5.0' : '23.10.1'),
    });
    expect(first).toMatchObject({ kind: 'electron', runtime: electronRuntime });

    for (const answer of [undefined, 'Welcome to Node.js\n26.5.0']) {
      const silent = await chooseShimRuntime({
        path: at('real'),
        shimDirectories: [],
        electron,
        probe: async () => answer,
      });
      expect(silent).toMatchObject({ kind: 'electron', reason: `${at('real', 'node')} reported no node version` });
    }

    const probe = vi.fn(async () => '26.5.0');
    const absent = await chooseShimRuntime({
      path: [at('empty'), at('shim')].join(delimiter),
      shimDirectories: [at('shim')],
      electron,
      probe,
    });
    expect(absent).toEqual({
      kind: 'electron',
      runtime: electronRuntime,
      command: electron.command,
      version: '24.18.0',
      reason: 'no node on PATH',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  // A real node answers, run without a shell: a path no shell could take unquoted.
  it(
    'probes a real node for its version, and answers undefined for what cannot say in time',
    { timeout: 60_000 },
    async () => {
      const odd = at(`odd 'dir' $(false)`);
      await mkdir(odd);
      await symlink(process.execPath, join(odd, 'node'));
      await expect(probeNodeVersion(join(odd, 'node'))).resolves.toBe(process.versions.node);
      await expect(probeNodeVersion(at('missing', 'node'))).resolves.toBeUndefined();
      // A wrapper whose child outlives the kill and keeps the output open: the bound still holds.
      await writeFile(at('slow'), '#!/bin/sh\nsleep 20\n');
      await chmod(at('slow'), 0o755);
      const started = Date.now();
      await expect(probeNodeVersion(at('slow'), 200)).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(10_000);
    },
  );
});
