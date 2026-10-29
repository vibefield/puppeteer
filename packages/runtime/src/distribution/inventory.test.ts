import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DistributionProvider, DistributionService, InstallCandidate } from '@vibefield/puppeteer-core';
import { createInstallationInventory, searchPathDirectories } from './inventory.js';

const descriptor: DistributionProvider = {
  id: 'example',
  label: 'Example',
  commands: ['example'],
  npmPackages: ['@example/cli'],
  brewNames: ['example'],
  detectors: [],
  nativeUpdateCheck: false,
};

/** A fake adapter: it accepts anything whose file name starts with `example`. */
function fakeService(
  provider: DistributionProvider,
  seen: InstallCandidate[],
  versionOf: (candidate: InstallCandidate) => string | undefined = () => '1.2.3',
): DistributionService {
  return {
    provider,
    async inspect(candidate) {
      seen.push(candidate);
      const name = basename(candidate.realPath);
      if (!name.startsWith('example')) return undefined;
      const version = versionOf(candidate);
      return {
        provider: provider.id,
        executable: candidate.executable,
        realPath: candidate.realPath,
        ...(version === undefined ? {} : { version }),
        method: candidate.packageRoot ? 'npm-global' : 'standalone-binary',
        ...(candidate.packageRoot === undefined ? {} : { location: candidate.packageRoot }),
        autoUpdate: 'unknown',
        detectedAt: '2026-09-06T12:00:00.000Z',
        warnings: [],
      };
    },
    recipeFor: () => ({ kind: 'manual', instructions: 'reinstall by hand' }),
  };
}

async function machine(): Promise<{
  root: string;
  searchPath: string;
  brewPrefix: string;
  pathExecutable: string;
  linkedExecutable: string;
  npmExecutable: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'puppeteer-inventory-')));
  await mkdir(join(root, 'bin1'), { recursive: true });
  await mkdir(join(root, 'bin2'), { recursive: true });
  await mkdir(join(root, 'versions'), { recursive: true });
  await mkdir(join(root, 'npm', 'bin'), { recursive: true });
  await mkdir(join(root, 'npm', 'lib', 'node_modules', '@example', 'cli', 'bin'), { recursive: true });
  await mkdir(join(root, 'brew', 'Caskroom', 'example'), { recursive: true });
  await mkdir(join(root, 'brew', 'bin'), { recursive: true });

  await writeFile(join(root, 'bin1', 'example'), '#!/bin/sh\n');
  await writeFile(join(root, 'versions', 'example-1.2.3'), '#!/bin/sh\n');
  await symlink(join(root, 'versions', 'example-1.2.3'), join(root, 'bin2', 'example'));
  await writeFile(
    join(root, 'npm', 'lib', 'node_modules', '@example', 'cli', 'package.json'),
    JSON.stringify({ name: '@example/cli', bin: { example: 'bin/example.js' } }),
  );
  await writeFile(join(root, 'npm', 'lib', 'node_modules', '@example', 'cli', 'bin', 'example.js'), '// cli\n');
  await writeFile(join(root, 'brew', 'bin', 'example'), '#!/bin/sh\n');

  return {
    root,
    searchPath: [join(root, 'bin1'), join(root, 'bin2'), join(root, 'npm', 'bin'), join(root, 'missing')].join(
      delimiter,
    ),
    brewPrefix: join(root, 'brew'),
    pathExecutable: join(root, 'bin1', 'example'),
    linkedExecutable: join(root, 'bin2', 'example'),
    npmExecutable: join(root, 'npm', 'lib', 'node_modules', '@example', 'cli', 'bin', 'example.js'),
  };
}

describe('searchPathDirectories', () => {
  it('preserves order, drops duplicates, and never searches the working directory', () => {
    expect(searchPathDirectories(['/a', '', '/b', '/a', '  '].join(delimiter))).toEqual(['/a', '/b']);
    expect(searchPathDirectories(undefined)).toEqual([]);
  });
});

describe('createInstallationInventory', () => {
  it('reports every PATH match, resolves symlinks, and binds the configured executable as active', async () => {
    const box = await machine();
    const seen: InstallCandidate[] = [];
    const inventory = createInstallationInventory({
      providers: [
        {
          providerId: 'example',
          service: fakeService(descriptor, seen),
          launchExecutables: [box.linkedExecutable, 'example'],
        },
      ],
      searchPath: box.searchPath,
      brewPrefixes: [box.brewPrefix],
    });

    const installations = await inventory.inspect();
    const active = installations.filter((installation) => installation.active);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      executable: box.linkedExecutable,
      realPath: join(box.root, 'versions', 'example-1.2.3'),
      origin: 'configured',
    });
    // Two installs of one agent are normal and are shown, not hidden.
    expect(installations.map((installation) => installation.origin).sort()).toEqual([
      'brew',
      'configured',
      'npm-global',
      'path',
    ]);
    expect(installations.map((installation) => installation.executable)).toContain(box.pathExecutable);
    // The symlink and its target are one file, so they are one candidate.
    expect(seen.filter((candidate) => candidate.realPath === join(box.root, 'versions', 'example-1.2.3'))).toHaveLength(
      1,
    );
  });

  it('derives npm global roots from PATH bin siblings and reads the package bin entry', async () => {
    const box = await machine();
    const seen: InstallCandidate[] = [];
    const inventory = createInstallationInventory({
      providers: [{ providerId: 'example', service: fakeService(descriptor, seen), launchExecutables: [] }],
      searchPath: box.searchPath,
      brewPrefixes: [box.brewPrefix],
    });

    const installations = await inventory.inspect();
    const npmInstall = installations.find((installation) => installation.origin === 'npm-global');
    expect(npmInstall).toMatchObject({
      executable: box.npmExecutable,
      location: join(box.root, 'npm', 'lib', 'node_modules', '@example', 'cli'),
    });
    const brewInstall = installations.find((installation) => installation.origin === 'brew');
    expect(brewInstall?.executable).toBe(join(box.brewPrefix, 'bin', 'example'));
    // Without a configured executable the shell's first PATH match is active.
    expect(installations.find((installation) => installation.active)?.executable).toBe(box.pathExecutable);
  });

  it("searches the provider's install directories under the home, after the search path, never as the launch", async () => {
    const box = await machine();
    const home = join(box.root, 'home');
    await mkdir(join(home, '.example', 'bin'), { recursive: true });
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    await writeFile(join(home, '.example', 'bin', 'example'), '#!/bin/sh\n');
    await writeFile(join(home, '.local', 'bin', 'example'), '#!/bin/sh\n');
    const provider: DistributionProvider = { ...descriptor, installDirectories: ['.example/bin', '.local/bin'] };
    const inventoryOn = (searchPath: string) =>
      createInstallationInventory({
        providers: [{ providerId: 'example', service: fakeService(provider, []), launchExecutables: [] }],
        searchPath,
        brewPrefixes: [],
        home,
      });

    // A directory the search path also reaches keeps its PATH origin, and stays the launch.
    const installations = await inventoryOn(join(home, '.local', 'bin')).inspect();
    expect(installations.map(({ executable, origin, active }) => ({ executable, origin, active }))).toEqual([
      { executable: join(home, '.local', 'bin', 'example'), origin: 'path', active: true },
      { executable: join(home, '.example', 'bin', 'example'), origin: 'install-directory', active: false },
    ]);
    expect(installations[0]?.warnings).toEqual([]);
    // Found, and said to be off the search path: a launch by command name does not reach it.
    expect(installations[1]?.warnings).toEqual([`${join(home, '.example', 'bin')} is not on the search path`]);

    // A search path that names none of them, as launchd's does: both are found, neither is the launch.
    const short = await inventoryOn(join(box.root, 'missing')).inspect();
    expect(short.map(({ origin, active }) => ({ origin, active }))).toEqual([
      { origin: 'install-directory', active: false },
      { origin: 'install-directory', active: false },
    ]);
  });

  it('caches per provider until refresh and clears on invalidate', async () => {
    const box = await machine();
    const seen: InstallCandidate[] = [];
    const service = fakeService(descriptor, seen);
    const inspect = vi.spyOn(service, 'inspect');
    const inventory = createInstallationInventory({
      providers: [{ providerId: 'example', service, launchExecutables: [] }],
      searchPath: box.searchPath,
      brewPrefixes: [box.brewPrefix],
    });

    await inventory.inspect();
    const afterFirst = inspect.mock.calls.length;
    await inventory.inspect();
    expect(inspect.mock.calls.length).toBe(afterFirst);

    await inventory.inspect({ refresh: true });
    expect(inspect.mock.calls.length).toBe(afterFirst * 2);

    inventory.invalidate('example');
    await inventory.active('example');
    expect(inspect.mock.calls.length).toBe(afterFirst * 3);
  });

  it('discards adapter output that names another provider or fails validation', async () => {
    const box = await machine();
    const onError = vi.fn();
    const impostor: DistributionService = {
      provider: descriptor,
      async inspect(candidate) {
        return {
          provider: 'other',
          executable: candidate.executable,
          realPath: candidate.realPath,
          method: 'unknown',
          autoUpdate: 'unknown',
          detectedAt: '2026-09-06T12:00:00.000Z',
          warnings: [],
        };
      },
      recipeFor: () => ({ kind: 'manual', instructions: 'n/a' }),
    };
    const inventory = createInstallationInventory({
      providers: [{ providerId: 'example', service: impostor, launchExecutables: [] }],
      searchPath: box.searchPath,
      brewPrefixes: [box.brewPrefix],
      onError,
    });

    await expect(inventory.inspect()).resolves.toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('other') }));
  });

  it('survives an adapter that throws and returns nothing for unknown providers', async () => {
    const box = await machine();
    const onError = vi.fn();
    const broken: DistributionService = {
      provider: descriptor,
      async inspect() {
        throw new Error('native probe blew up');
      },
      recipeFor: () => ({ kind: 'manual', instructions: 'n/a' }),
    };
    const inventory = createInstallationInventory({
      providers: [{ providerId: 'example', service: broken, launchExecutables: [] }],
      searchPath: box.searchPath,
      brewPrefixes: [box.brewPrefix],
      onError,
    });

    await expect(inventory.inspect()).resolves.toEqual([]);
    await expect(inventory.inspect({ providerId: 'nobody' })).resolves.toEqual([]);
    await expect(inventory.active('nobody')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
