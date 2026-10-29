import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentInstallation,
  DistributionProvider,
  DistributionService,
  InstallRecipe,
} from '@vibefield/puppeteer-core';
import { installArgv, installRequires, planAgentInstall, runAgentInstall } from './install.js';
import type { UpdateCommandRunner } from './update.js';

const provider: DistributionProvider = {
  id: 'example',
  label: 'Example',
  commands: ['example'],
  npmPackages: ['@example/cli'],
  brewNames: ['example'],
  detectors: [],
  nativeUpdateCheck: false,
};

const script: InstallRecipe = { kind: 'installer-script', url: 'https://example.com/install.sh' };

function installation(overrides: Partial<AgentInstallation> = {}): AgentInstallation {
  return {
    provider: 'example',
    executable: '/home/user/.local/bin/example',
    realPath: '/home/user/.local/share/example/versions/1.2.3',
    version: '1.2.3',
    method: 'native-installer',
    autoUpdate: 'unknown',
    detectedAt: '2026-10-29T12:00:00.000Z',
    warnings: [],
    origin: 'path',
    active: true,
    ...overrides,
  };
}

function service(installRecipe?: () => InstallRecipe): DistributionService {
  return {
    provider,
    async inspect() {
      return undefined;
    },
    recipeFor: () => ({ kind: 'manual', instructions: 'unused' }),
    ...(installRecipe === undefined ? {} : { installRecipe }),
  };
}

/** A search path whose one directory holds the named executables. */
async function searchPathWith(...commands: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'puppeteer-install-bin-'));
  for (const command of commands) {
    await writeFile(join(directory, command), '#!/bin/sh\n');
    await chmod(join(directory, command), 0o755);
  }
  return directory;
}

async function transcripts(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'puppeteer-install-')), 'updates');
}

describe('installArgv and installRequires', () => {
  it('resolves each recipe to the command a person would run for a first install', () => {
    expect(installArgv(script)).toEqual([
      '/bin/bash',
      '-c',
      'set -o pipefail; curl --proto =https --tlsv1.2 -fsSL "$1" | bash',
      'puppeteer-install',
      'https://example.com/install.sh',
    ]);
    // A vendor that documents `| sh` gets sh.
    expect(installArgv({ ...script, shell: 'sh' })?.[2]).toBe(
      'set -o pipefail; curl --proto =https --tlsv1.2 -fsSL "$1" | sh',
    );
    expect(installArgv({ kind: 'npm-global', package: '@example/cli' })).toEqual([
      'npm',
      'install',
      '-g',
      '@example/cli@latest',
    ]);
    expect(installArgv({ kind: 'npm-global', package: '@example/cli', version: '1.2.3' })).toEqual([
      'npm',
      'install',
      '-g',
      '@example/cli@1.2.3',
    ]);
    expect(installArgv({ kind: 'brew', name: 'example', cask: true })).toEqual([
      'brew',
      'install',
      '--cask',
      'example',
    ]);
    expect(installArgv({ kind: 'brew', name: 'example', cask: false })).toEqual(['brew', 'install', 'example']);
    expect(installArgv({ kind: 'manual', instructions: 'Download the app.' })).toBeUndefined();
  });

  it('names the commands each recipe runs from the search path', () => {
    expect(installRequires(script)).toEqual(['curl', 'bash']);
    // The shell the script is piped to, and what the script itself says it needs.
    expect(installRequires({ ...script, shell: 'sh', needs: ['node', 'npm', 'curl'] })).toEqual([
      'curl',
      'sh',
      'node',
      'npm',
    ]);
    expect(installRequires({ kind: 'npm-global', package: '@example/cli' })).toEqual(['npm']);
    expect(installRequires({ kind: 'brew', name: 'example', cask: true })).toEqual(['brew']);
    expect(installRequires({ kind: 'manual', instructions: 'Download the app.' })).toEqual([]);
  });
});

describe('planAgentInstall', () => {
  it('says what the button runs and which of its commands the search path lacks', async () => {
    const withCurl = await searchPathWith('curl', 'bash');
    await expect(planAgentInstall(script, { searchPath: withCurl })).resolves.toEqual({
      recipe: script,
      argv: installArgv(script),
      requires: ['curl', 'bash'],
      missing: [],
    });
    await expect(planAgentInstall({ ...script, needs: ['node'] }, { searchPath: withCurl })).resolves.toMatchObject({
      requires: ['curl', 'bash', 'node'],
      missing: ['node'],
    });
    const npm: InstallRecipe = { kind: 'npm-global', package: '@example/cli' };
    await expect(planAgentInstall(npm, { searchPath: withCurl })).resolves.toEqual({
      recipe: npm,
      argv: installArgv(npm),
      requires: ['npm'],
      missing: ['npm'],
    });
    // A file that is not executable is not a command.
    const notExecutable = await mkdtemp(join(tmpdir(), 'puppeteer-install-bin-'));
    await writeFile(join(notExecutable, 'npm'), '');
    await expect(planAgentInstall(npm, { searchPath: notExecutable })).resolves.toMatchObject({ missing: ['npm'] });
  });

  it('plans a manual recipe without a command', async () => {
    const manual: InstallRecipe = { kind: 'manual', instructions: 'Download the app.' };
    await expect(planAgentInstall(manual, { searchPath: undefined })).resolves.toEqual({
      recipe: manual,
      requires: [],
      missing: [],
    });
  });
});

describe('runAgentInstall', () => {
  it('runs nothing when the agent is already installed', async () => {
    const run = vi.fn<UpdateCommandRunner>();
    const present = installation();
    const receipt = await runAgentInstall({
      provider,
      service: service(() => script),
      inspect: async () => present,
      searchPath: await searchPathWith('curl', 'bash'),
      transcriptsDirectory: await transcripts(),
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      provider: 'example',
      status: 'present',
      after: { executable: present.executable, version: '1.2.3' },
      message: 'Example is already installed at /home/user/.local/bin/example',
    });
    // The receipt carries the classified install, never the host's ranking.
    expect(receipt.after).not.toHaveProperty('active');
  });

  it('reports an adapter that declares no install, or only instructions, as unsupported', async () => {
    const run = vi.fn<UpdateCommandRunner>();
    const common = { provider, inspect: async () => undefined, searchPath: undefined, run };
    await expect(runAgentInstall({ ...common, service: service() })).resolves.toMatchObject({
      status: 'unsupported',
      message: 'Example declares no install',
    });
    await expect(
      runAgentInstall({
        ...common,
        service: service(() => ({ kind: 'manual', instructions: 'Download the app from example.com.' })),
      }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      recipe: { kind: 'manual' },
      message: 'Download the app from example.com.',
    });
    await expect(
      runAgentInstall({ ...common, service: service(() => script), platform: 'win32' }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      recipe: script,
      message: "Example's install script runs on macOS and Linux only",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('never runs an installer when it cannot tell whether the agent is installed', async () => {
    const run = vi.fn<UpdateCommandRunner>();
    const onError = vi.fn();
    const receipt = await runAgentInstall({
      provider,
      service: service(() => script),
      inspect: async () => {
        throw new Error('inventory unreadable');
      },
      searchPath: await searchPathWith('curl', 'bash'),
      run,
      onError,
    });
    expect(run).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ status: 'failed', message: 'could not tell whether Example is installed' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'inventory unreadable' }));
  });

  it('fails an adapter whose recipe throws, and says so to the host', async () => {
    const onError = vi.fn();
    const receipt = await runAgentInstall({
      provider,
      service: service(() => {
        throw new Error('no recipe');
      }),
      inspect: async () => undefined,
      searchPath: undefined,
      onError,
    });
    expect(receipt).toMatchObject({ status: 'failed', message: 'adapter could not produce an install recipe' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'no recipe' }));
  });

  it('names a missing command instead of running an installer that cannot work', async () => {
    const run = vi.fn<UpdateCommandRunner>();
    const receipt = await runAgentInstall({
      provider,
      service: service(() => ({ kind: 'npm-global', package: '@example/cli' })),
      inspect: async () => undefined,
      searchPath: await searchPathWith('curl', 'bash'),
      transcriptsDirectory: await transcripts(),
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      status: 'failed',
      missing: ['npm'],
      message: 'needs npm, which is not on the search path',
    });
    expect(receipt).not.toHaveProperty('transcriptPath');
  });

  it('runs the vendor installer unattended on the search path and judges it by inspecting again', async () => {
    const searchPath = await searchPathWith('curl', 'bash');
    const directory = await transcripts();
    const recipe: InstallRecipe = { ...script, env: { EXAMPLE_NO_MODIFY_PATH: '1' }, timeoutMs: 120_000 };
    const inspect = vi
      .fn<() => Promise<AgentInstallation | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(installation());
    const run = vi.fn<UpdateCommandRunner>(async (request) => {
      request.onOutput('Installing Example 1.2.3…\n');
      return { exitCode: 0 };
    });
    const seen: string[] = [];
    const receipt = await runAgentInstall({
      provider,
      service: service(() => recipe),
      inspect,
      searchPath,
      shell: '/bin/zsh',
      transcriptsDirectory: directory,
      run,
      onOutput: (chunk) => seen.push(chunk),
    });

    expect(run).toHaveBeenCalledTimes(1);
    const request = run.mock.calls[0]![0];
    expect(request.argv).toEqual(installArgv(recipe));
    // The installer looks for its tools where the inventory then looks for the agent.
    expect(request.env.PATH).toBe(searchPath);
    expect(request.env.EXAMPLE_NO_MODIFY_PATH).toBe('1');
    // A first install is the vendor's whole install: the installer reads the person's shell.
    expect(request.env.SHELL).toBe('/bin/zsh');
    expect(request.timeoutMs).toBe(120_000);
    expect(seen).toEqual(['Installing Example 1.2.3…\n']);

    expect(receipt).toMatchObject({
      provider: 'example',
      status: 'installed',
      recipe,
      after: { executable: '/home/user/.local/bin/example', version: '1.2.3' },
      exitCode: 0,
      message: 'installed Example 1.2.3',
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    const [file] = await readdir(directory);
    expect(receipt.transcriptPath).toBe(join(directory, file!));
    await expect(readFile(receipt.transcriptPath!, 'utf8')).resolves.toBe('Installing Example 1.2.3…\n');
    expect((await stat(receipt.transcriptPath!)).mode & 0o777).toBe(0o600);
  });

  it('counts an install found after a non-zero exit, and says how the installer ended', async () => {
    const inspect = vi
      .fn<() => Promise<AgentInstallation | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(installation());
    const receipt = await runAgentInstall({
      provider,
      service: service(() => script),
      inspect,
      searchPath: await searchPathWith('curl', 'bash'),
      transcriptsDirectory: await transcripts(),
      run: async () => ({ exitCode: 1 }),
    });
    expect(receipt).toMatchObject({
      status: 'installed',
      exitCode: 1,
      message: 'installed Example 1.2.3; the installer then exited with 1',
    });
  });

  it('says not-found when the installer finished but nothing is where the host looks', async () => {
    const receipt = await runAgentInstall({
      provider,
      service: service(() => script),
      inspect: async () => undefined,
      searchPath: await searchPathWith('curl', 'bash'),
      transcriptsDirectory: await transcripts(),
      run: async () => ({ exitCode: 0 }),
    });
    expect(receipt).toMatchObject({
      status: 'not-found',
      exitCode: 0,
      message: 'the installer finished, but no Example was found on the search path or in its install directories',
    });
    expect(receipt).not.toHaveProperty('after');
  });

  it('fails an installer that did not finish, naming how it ended', async () => {
    const common = {
      provider,
      service: service(() => script),
      inspect: async () => undefined,
      searchPath: await searchPathWith('curl', 'bash'),
      transcriptsDirectory: await transcripts(),
    };
    await expect(runAgentInstall({ ...common, run: async () => ({ exitCode: 2 }) })).resolves.toMatchObject({
      status: 'failed',
      exitCode: 2,
      message: 'install command exited with 2',
    });
    await expect(
      runAgentInstall({ ...common, run: async () => ({ exitCode: null, error: 'stopped before it finished' }) }),
    ).resolves.toMatchObject({ status: 'failed', message: 'install command stopped before it finished' });
    await expect(
      runAgentInstall({
        ...common,
        run: async () => {
          throw new Error('spawn exploded');
        },
      }),
    ).resolves.toMatchObject({ status: 'failed', message: 'install command could not be started' });
  });

  it('keeps installing when the host observer throws', async () => {
    const onError = vi.fn();
    const inspect = vi
      .fn<() => Promise<AgentInstallation | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(installation());
    const receipt = await runAgentInstall({
      provider,
      service: service(() => script),
      inspect,
      searchPath: await searchPathWith('curl', 'bash'),
      transcriptsDirectory: await transcripts(),
      run: async (request) => {
        request.onOutput('a line\n');
        return { exitCode: 0 };
      },
      onOutput: () => {
        throw new Error('display gone');
      },
      onError,
    });
    expect(receipt.status).toBe('installed');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'display gone' }));
  });

  it('installs into a transcripts directory it creates owner-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'puppeteer-install-'));
    await mkdir(join(root, 'nested'));
    const directory = join(root, 'nested', 'updates');
    await runAgentInstall({
      provider,
      service: service(() => script),
      inspect: async () => undefined,
      searchPath: await searchPathWith('curl', 'bash'),
      transcriptsDirectory: directory,
      run: async () => ({ exitCode: 0 }),
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });
});
