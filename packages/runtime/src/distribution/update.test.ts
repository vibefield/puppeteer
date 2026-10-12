import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentInstallation,
  DistributionProvider,
  DistributionService,
  InstalledAgent,
  UpdateRecipe,
} from '@vibefield/puppeteer-core';
import {
  planInstallationUpdate,
  recipeArgv,
  resolveNpmCommand,
  runInstallationUpdate,
  runUpdateCommand,
  type UpdateCommandRunner,
} from './update.js';

const provider: DistributionProvider = {
  id: 'example',
  label: 'Example',
  commands: ['example'],
  npmPackages: ['@example/cli'],
  brewNames: ['example'],
  detectors: [],
  nativeUpdateCheck: false,
};

function installation(overrides: Partial<AgentInstallation> = {}): AgentInstallation {
  return {
    provider: 'example',
    executable: '/usr/local/bin/example',
    realPath: '/usr/local/bin/example',
    version: '1.2.3',
    method: 'standalone-binary',
    autoUpdate: 'unknown',
    detectedAt: '2026-09-06T12:00:00.000Z',
    warnings: [],
    origin: 'path',
    active: true,
    ...overrides,
  };
}

function service(recipe: UpdateRecipe): DistributionService {
  return {
    provider,
    async inspect() {
      return undefined;
    },
    recipeFor: () => recipe,
  };
}

async function transcripts(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'puppeteer-update-')), 'updates');
}

describe('resolveNpmCommand', () => {
  it('runs the node and npm that own a global install', async () => {
    const prefix = await mkdtemp(join(tmpdir(), 'puppeteer-npm-'));
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await mkdir(join(prefix, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
    await writeFile(join(prefix, 'bin', 'node'), '');
    await writeFile(join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');

    const install = installation({ location: join(prefix, 'lib', 'node_modules', '@example', 'cli') });
    await expect(resolveNpmCommand(install)).resolves.toEqual([
      join(prefix, 'bin', 'node'),
      join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]);
  });

  it('falls back to npm on PATH when the prefix carries no npm', async () => {
    await expect(resolveNpmCommand(installation({ location: '/opt/example' }))).resolves.toEqual(['npm']);
    await expect(resolveNpmCommand(installation())).resolves.toEqual(['npm']);
  });
});

describe('recipeArgv', () => {
  it('builds the vendor command for each recipe kind', async () => {
    await expect(
      recipeArgv({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] }, installation()),
    ).resolves.toEqual(['/usr/local/bin/example', 'update']);
    await expect(
      recipeArgv({ kind: 'npm-global', package: '@example/cli' }, installation(), async () => false),
    ).resolves.toEqual(['npm', 'install', '-g', '@example/cli@latest']);
    await expect(
      recipeArgv({ kind: 'npm-global', package: '@example/cli', version: '1.3.0' }, installation(), async () => false),
    ).resolves.toEqual(['npm', 'install', '-g', '@example/cli@1.3.0']);
    await expect(recipeArgv({ kind: 'brew', name: 'example', cask: true }, installation())).resolves.toEqual([
      'brew',
      'upgrade',
      '--cask',
      'example',
    ]);
    await expect(recipeArgv({ kind: 'manual', instructions: 'download it' }, installation())).resolves.toBeUndefined();
  });

  it('runs an installer script the way its vendor documents — curl | bash — with the URL never spliced into the script', async () => {
    const argv = await recipeArgv({ kind: 'installer-script', url: 'https://example.com/install.sh' }, installation());
    expect(argv?.slice(0, 2)).toEqual(['/bin/bash', '-c']);
    expect(argv?.[2]).toBe('set -o pipefail; curl --proto =https --tlsv1.2 -fsSL "$1" | bash');
    expect(argv?.slice(3)).toEqual(['puppeteer-update', 'https://example.com/install.sh']);
  });
});

describe('runInstallationUpdate', () => {
  it('runs the native command in a clean environment and proves success by re-inspecting', async () => {
    const directory = await transcripts();
    const seen: Parameters<UpdateCommandRunner>[0][] = [];
    const receipt = await runInstallationUpdate({
      provider,
      service: service({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] }),
      install: installation(),
      reinspect: async () => installation({ version: '1.3.0' }),
      transcriptsDirectory: directory,
      run: async (request) => {
        seen.push(request);
        request.onOutput('downloading...\n');
        request.onOutput('installed 1.3.0\n');
        return { exitCode: 0 };
      },
    });

    expect(receipt).toMatchObject({
      provider: 'example',
      status: 'updated',
      exitCode: 0,
      before: { version: '1.2.3' },
      after: { version: '1.3.0' },
    });
    expect(receipt.recipe).toEqual({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] });
    // The receipt carries adapter-classified installs, not the host's ranking.
    expect(receipt.before).not.toHaveProperty('active');
    expect(seen[0]?.argv).toEqual(['/usr/local/bin/example', 'update']);
    expect(seen[0]?.env).toMatchObject({ TERM: 'xterm-256color' });
    expect(Object.keys(seen[0]?.env ?? {})).not.toContain('npm_config_registry');

    const transcript = receipt.transcriptPath!;
    expect(await readFile(transcript, 'utf8')).toBe('downloading...\ninstalled 1.3.0\n');
    if (process.platform !== 'win32') expect((await stat(transcript)).mode & 0o777).toBe(0o600);
    if (process.platform !== 'win32') expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('reports unchanged — never a currency it has no evidence for — when a clean run left the version where it was', async () => {
    const receipt = await runInstallationUpdate({
      provider,
      service: service({ kind: 'npm-global', package: '@example/cli' }),
      install: installation({ method: 'npm-global', location: '/opt/example' }),
      reinspect: async () => installation({ method: 'npm-global', location: '/opt/example' }),
      transcriptsDirectory: await transcripts(),
      exists: async () => false,
      run: async (request) => {
        expect(request.argv).toEqual(['npm', 'install', '-g', '@example/cli@latest']);
        return { exitCode: 0 };
      },
    });

    expect(receipt).toMatchObject({ status: 'unchanged', exitCode: 0, message: 'still 1.2.3' });
  });

  it("gives an installer script the variables it documents, every updater unbuffered output, and a recipe's own budget", async () => {
    const seen: Parameters<UpdateCommandRunner>[0][] = [];
    const run: UpdateCommandRunner = async (request) => {
      seen.push(request);
      return { exitCode: 0 };
    };
    await runInstallationUpdate({
      provider,
      service: service({
        kind: 'installer-script',
        url: 'https://example.com/install.sh',
        env: { EXAMPLE_INSTALL_DIR: '/home/tester/.example', EXAMPLE_NO_MODIFY_PATH: '1' },
      }),
      install: installation(),
      reinspect: async () => installation(),
      transcriptsDirectory: await transcripts(),
      run,
    });
    await runInstallationUpdate({
      provider,
      service: service({
        kind: 'native-self-update',
        argv: ['/usr/local/bin/example', 'update'],
        timeoutMs: 2_700_000,
      }),
      install: installation(),
      reinspect: async () => installation(),
      transcriptsDirectory: await transcripts(),
      run,
    });
    expect(seen[0]?.env).toMatchObject({
      EXAMPLE_INSTALL_DIR: '/home/tester/.example',
      EXAMPLE_NO_MODIFY_PATH: '1',
      PYTHONUNBUFFERED: '1',
    });
    expect(seen[0]?.timeoutMs).toBe(15 * 60_000);
    expect(seen[1]?.env).not.toHaveProperty('EXAMPLE_INSTALL_DIR');
    expect(seen[1]?.timeoutMs).toBe(2_700_000);
  });

  it('says an update the person stopped was stopped, and still reports a version that moved first', async () => {
    const stopRun: UpdateCommandRunner = async (request) => {
      expect(request.signal?.aborted).toBe(true);
      return { exitCode: null, signal: 'SIGTERM', error: 'stopped before it finished' };
    };
    const controller = new AbortController();
    controller.abort();
    const stopped = await runInstallationUpdate({
      provider,
      service: service({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] }),
      install: installation(),
      reinspect: async () => installation(),
      transcriptsDirectory: await transcripts(),
      signal: controller.signal,
      run: stopRun,
    });
    expect(stopped).toMatchObject({ status: 'failed', message: 'update command stopped before it finished' });

    const movedFirst = await runInstallationUpdate({
      provider,
      service: service({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] }),
      install: installation(),
      reinspect: async () => installation({ version: '1.3.0' }),
      transcriptsDirectory: await transcripts(),
      signal: controller.signal,
      run: stopRun,
    });
    expect(movedFirst).toMatchObject({
      status: 'updated',
      message: 'updated from 1.2.3 to 1.3.0; the updater was then stopped before it finished',
    });

    // A clean exit the runner did not end is the only success: a stop that
    // happens to exit 0 is still a stop.
    const exitedZero = await runInstallationUpdate({
      provider,
      service: service({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] }),
      install: installation(),
      reinspect: async () => installation(),
      transcriptsDirectory: await transcripts(),
      run: async () => ({ exitCode: 0, error: 'timed out after 15 min' }),
    });
    expect(exitedZero.status).toBe('failed');
  });

  it('reports failure on a non-zero exit and keeps the transcript', async () => {
    const receipt = await runInstallationUpdate({
      provider,
      service: service({ kind: 'brew', name: 'example', cask: false }),
      install: installation(),
      reinspect: async () => installation(),
      transcriptsDirectory: await transcripts(),
      run: async (request) => {
        request.onOutput('Error: no such formula\n');
        return { exitCode: 1 };
      },
    });

    expect(receipt).toMatchObject({ status: 'failed', exitCode: 1, message: 'update command exited with 1' });
    expect(await readFile(receipt.transcriptPath!, 'utf8')).toContain('no such formula');
  });

  it('reports a manual recipe as unsupported without running anything', async () => {
    const directory = await transcripts();
    const run = vi.fn<UpdateCommandRunner>();
    const receipt = await runInstallationUpdate({
      provider,
      service: service({ kind: 'manual', instructions: 'download the installer from the vendor' }),
      install: installation(),
      reinspect: async () => installation(),
      transcriptsDirectory: directory,
      run,
    });

    expect(receipt).toMatchObject({
      status: 'unsupported',
      message: 'download the installer from the vendor',
    });
    expect(receipt.transcriptPath).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    await expect(readdir(directory)).rejects.toThrow();
  });

  it('survives an adapter that cannot produce a recipe and a runner that cannot start', async () => {
    const onError = vi.fn();
    const broken = await runInstallationUpdate({
      provider,
      service: {
        provider,
        async inspect() {
          return undefined;
        },
        recipeFor() {
          throw new Error('adapter bug');
        },
      },
      install: installation(),
      reinspect: async () => installation(),
      transcriptsDirectory: await transcripts(),
      onError,
    });
    expect(broken).toMatchObject({ status: 'failed', message: 'adapter could not produce an update recipe' });

    const unstartable = await runInstallationUpdate({
      provider,
      service: service({ kind: 'native-self-update', argv: ['/missing/example', 'update'] }),
      install: installation(),
      reinspect: async () => undefined,
      transcriptsDirectory: await transcripts(),
      run: async () => {
        throw new Error('spawn ENOENT');
      },
      onError,
    });
    expect(unstartable).toMatchObject({ status: 'failed', message: 'update command could not be started' });
    expect(unstartable.exitCode).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('runInstallationUpdate output observer', () => {
  it('hands the updater output to the observer as it arrives, beside the transcript', async () => {
    const directory = await transcripts();
    const seen: string[] = [];
    const receipt = await runInstallationUpdate({
      provider,
      service: service({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] }),
      install: installation(),
      reinspect: async () => installation({ version: '1.3.0' }),
      transcriptsDirectory: directory,
      onOutput: (chunk) => seen.push(chunk),
      run: async (request) => {
        request.onOutput('downloading...\n');
        request.onOutput('installed 1.3.0\n');
        return { exitCode: 0 };
      },
    });

    expect(seen).toEqual(['downloading...\n', 'installed 1.3.0\n']);
    expect(receipt.status).toBe('updated');
    await expect(readFile(receipt.transcriptPath!, 'utf8')).resolves.toBe('downloading...\ninstalled 1.3.0\n');
  });

  it('contains an observer that throws: the update still runs to its receipt', async () => {
    const errors: Error[] = [];
    const receipt = await runInstallationUpdate({
      provider,
      service: service({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] }),
      install: installation(),
      reinspect: async () => installation({ version: '1.3.0' }),
      transcriptsDirectory: await transcripts(),
      onOutput: () => {
        throw new Error('display went away');
      },
      onError: (error) => errors.push(error),
      run: async (request) => {
        request.onOutput('downloading...\n');
        return { exitCode: 0 };
      },
    });

    expect(receipt.status).toBe('updated');
    expect(errors.map((error) => error.message)).toEqual(['display went away']);
  });
});

describe('planInstallationUpdate', () => {
  it('names the command an update would run, resolved the way the runner resolves it', async () => {
    await expect(
      planInstallationUpdate(
        service({ kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] }),
        installation(),
      ),
    ).resolves.toEqual({
      recipe: { kind: 'native-self-update', argv: ['/usr/local/bin/example', 'update'] },
      argv: ['/usr/local/bin/example', 'update'],
    });
    await expect(
      planInstallationUpdate(
        service({ kind: 'npm-global', package: '@example/cli' }),
        installation(),
        async () => false,
      ),
    ).resolves.toEqual({
      recipe: { kind: 'npm-global', package: '@example/cli' },
      argv: ['npm', 'install', '-g', '@example/cli@latest'],
    });
  });

  it('carries no command for a manual recipe', async () => {
    await expect(
      planInstallationUpdate(service({ kind: 'manual', instructions: 'download it' }), installation()),
    ).resolves.toEqual({ recipe: { kind: 'manual', instructions: 'download it' } });
  });

  it('asks the adapter with the install, never with the host ranking', async () => {
    const recipeFor = vi.fn((_install: InstalledAgent): UpdateRecipe => ({
      kind: 'manual',
      instructions: 'download it',
    }));
    await planInstallationUpdate({ provider, inspect: async () => undefined, recipeFor }, installation());
    expect(recipeFor).toHaveBeenCalledWith(expect.not.objectContaining({ active: true }));
    expect(recipeFor.mock.calls[0]?.[0]).not.toHaveProperty('origin');
  });
});

// The real runner, against real processes: an update runs unattended, so it
// has no stdin to wait on and no terminal to prompt on, and a stop or a timeout
// ends everything it started.
describe.skipIf(process.platform === 'win32')('runUpdateCommand', () => {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir() };
  const run = (script: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
    let output = '';
    const done = runUpdateCommand({
      argv: ['/bin/sh', '-c', script],
      env,
      cwd: tmpdir(),
      timeoutMs: extra.timeoutMs ?? 30_000,
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
      onOutput: (chunk) => {
        output += chunk;
      },
    });
    return { done, output: () => output };
  };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('streams both streams and a clean exit', async () => {
    const { done, output } = run('echo out; echo err >&2');
    await expect(done).resolves.toEqual({ exitCode: 0, signal: null });
    expect(output()).toContain('out\n');
    expect(output()).toContain('err\n');
  });

  it('answers a prompt on stdin with end-of-file instead of waiting for nobody', async () => {
    const started = Date.now();
    const { done, output } = run('read answer; echo "answer:[$answer]"');
    await expect(done).resolves.toMatchObject({ exitCode: 0 });
    expect(output()).toContain('answer:[]');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives the updater no controlling terminal to prompt on', async () => {
    const { done, output } = run('if (exec 3</dev/tty) 2>/dev/null; then echo tty; else echo no-tty; fi');
    await done;
    expect(output().trim()).toBe('no-tty');
  });

  it('stops the whole group on request, grandchildren included', async () => {
    const controller = new AbortController();
    const { done, output } = run('sleep 30 & echo "child:$!"; wait', { signal: controller.signal });
    for (let tries = 0; !output().includes('child:') && tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const child = Number(/child:(\d+)/u.exec(output())?.[1]);
    expect(alive(child)).toBe(true);
    controller.abort();
    // The abort arrives after spawn: the signal is wired, not only pre-checked.
    const result = await Promise.race([
      done,
      new Promise((resolve) => setTimeout(() => resolve('still running'), 10_000)),
    ]);
    expect(result).toMatchObject({ error: 'stopped before it finished' });
    // Signalled with its group; an orphan lingers as a zombie until launchd reaps it.
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 5_000, interval: 50 });
  }, 20_000);

  it('ends a run that outlives its budget, and says so', async () => {
    const { done } = run('sleep 30', { timeoutMs: 300 });
    await expect(done).resolves.toMatchObject({ exitCode: null, error: 'timed out after 1 s' });
  }, 20_000);
});
