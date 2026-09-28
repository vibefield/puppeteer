import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentLaunchProvider } from '@vibecook/puppeteer-core';
import {
  DEFAULT_RETRY_MS,
  LAUNCH_PROVIDERS_FILE,
  RENDEZVOUS_FILE,
  clearRendezvous,
  readLaunchProviders,
  readRendezvous,
  writeRendezvous,
} from './rendezvous.js';

const providers: AgentLaunchProvider[] = [
  {
    id: 'example',
    label: 'Example',
    resume: true,
    nativeInvocation: {
      commands: [{ name: 'example', executable: '/real/example' }],
      environmentVariables: ['EXAMPLE_HOME'],
    },
  },
];

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pst-'));
  home = join(root, 'home');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe('spawn-through rendezvous', { timeout: 60_000 }, () => {
  it('publishes the rendezvous and the provider table owner-only, and reads them back', async () => {
    await writeRendezvous(home, { port: 4242, token: 'bearer', strict: false, launchProviders: providers });

    expect(await modeOf(home)).toBe(0o700);
    expect(await modeOf(join(home, RENDEZVOUS_FILE))).toBe(0o600);
    expect(await modeOf(join(home, LAUNCH_PROVIDERS_FILE))).toBe(0o600);
    expect((await readdir(home)).sort()).toEqual([RENDEZVOUS_FILE, LAUNCH_PROVIDERS_FILE].sort());
    const rendezvous = await readRendezvous(home);
    expect(rendezvous).toMatchObject({
      format: 1,
      transport: 'tcp',
      host: '127.0.0.1',
      port: 4242,
      token: 'bearer',
      strict: false,
      retryMs: DEFAULT_RETRY_MS,
      pid: process.pid,
    });
    expect(Date.parse(rendezvous!.writtenAt)).not.toBeNaN();
    expect(rendezvous).not.toHaveProperty('imposterExecutable');
    expect(await readLaunchProviders(home)).toEqual(providers);

    await writeRendezvous(home, {
      port: 4343,
      token: 'rotated',
      strict: true,
      retryMs: 1_500,
      launchProviders: [],
      imposterExecutable: '/opt/ai',
    });
    expect(await readRendezvous(home)).toMatchObject({
      port: 4343,
      token: 'rotated',
      strict: true,
      retryMs: 1_500,
      imposterExecutable: '/opt/ai',
    });
    expect(await readLaunchProviders(home)).toEqual([]);
    expect((await readdir(home)).sort()).toEqual([RENDEZVOUS_FILE, LAUNCH_PROVIDERS_FILE].sort());
  });

  it('carries whether each adapter classifies through the provider table, and invents it for none', async () => {
    const classifying: AgentLaunchProvider = {
      id: 'classifying',
      label: 'Classifying',
      resume: true,
      nativeInvocation: {
        commands: [{ name: 'classifying', executable: '/real/classifying' }],
        environmentVariables: [],
        classifies: true,
      },
    };
    const declared: AgentLaunchProvider = {
      id: 'declared',
      label: 'Declared',
      resume: true,
      nativeInvocation: {
        commands: [{ name: 'declared', executable: '/real/declared' }],
        environmentVariables: [],
        classifies: false,
      },
    };
    // `providers` says nothing about classifying.
    const table = [classifying, declared, ...providers];
    await writeRendezvous(home, { port: 4242, token: 'bearer', strict: true, launchProviders: table });

    const read = await readLaunchProviders(home);
    expect(read).toEqual(table);
    expect(read!.map((provider) => provider.nativeInvocation?.classifies)).toEqual([true, false, undefined]);
    expect(read![2]!.nativeInvocation).not.toHaveProperty('classifies');
  });

  it('holds an existing, looser home to owner-only', async () => {
    await mkdir(home, { mode: 0o755 });
    await chmod(home, 0o755);
    await writeRendezvous(home, { port: 4242, token: 'bearer', strict: false, launchProviders: providers });
    expect(await modeOf(home)).toBe(0o700);
  });

  it('never shows a reader a half-written file', async () => {
    await writeRendezvous(home, { port: 1, token: 'token-0', strict: false, launchProviders: providers });
    const written = new Set(['token-0']);
    let writing = true;
    const writer = (async () => {
      for (let index = 1; index <= 100; index += 1) {
        const token = `token-${index}-${'x'.repeat(index)}`;
        written.add(token);
        await writeRendezvous(home, { port: index, token, strict: index % 2 === 0, launchProviders: providers });
      }
      writing = false;
    })();
    const seen: (string | undefined)[] = [];
    const reader = (async () => {
      while (writing) {
        const [rendezvous, table] = await Promise.all([readRendezvous(home), readLaunchProviders(home)]);
        seen.push(rendezvous?.token);
        expect(table).toEqual(providers);
      }
    })();
    await Promise.all([writer, reader]);

    expect(seen.length).toBeGreaterThan(10);
    // The name always exists once published, and always holds one whole write.
    for (const token of seen) expect(written.has(token!), String(token)).toBe(true);
    expect((await readdir(home)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('withdraws the rendezvous and leaves the provider table', async () => {
    await writeRendezvous(home, { port: 4242, token: 'bearer', strict: false, launchProviders: providers });
    await clearRendezvous(home);
    expect(await readRendezvous(home)).toBeUndefined();
    expect(await readLaunchProviders(home)).toEqual(providers);
    expect(await readdir(home)).toEqual([LAUNCH_PROVIDERS_FILE]);
    await expect(clearRendezvous(home)).resolves.toBeUndefined();
  });

  it("with a bearer, withdraws only that host's rendezvous and never a successor's", async () => {
    await writeRendezvous(home, { port: 4242, token: 'successor', strict: false, launchProviders: providers });
    await clearRendezvous(home, { token: 'predecessor' });
    expect((await readRendezvous(home))?.token).toBe('successor');
    await clearRendezvous(home, { token: 'successor' });
    expect(await readRendezvous(home)).toBeUndefined();
  });

  it('answers undefined, never throws, for a rendezvous a shim could not use', async () => {
    expect(await readRendezvous(join(root, 'absent'))).toBeUndefined();
    expect(await readLaunchProviders(join(root, 'absent'))).toBeUndefined();
    await mkdir(home, { recursive: true });
    const valid = {
      format: 1,
      transport: 'tcp',
      host: '127.0.0.1',
      port: 4242,
      token: 'bearer',
      strict: false,
      retryMs: 8_000,
      writtenAt: new Date().toISOString(),
      pid: 1,
    };
    for (const content of [
      '',
      '{"format":1',
      JSON.stringify({ ...valid, format: 2 }),
      JSON.stringify({ ...valid, host: '0.0.0.0' }),
      JSON.stringify({ ...valid, port: 0 }),
      JSON.stringify({ ...valid, token: '' }),
      JSON.stringify({ ...valid, strict: 'yes' }),
    ]) {
      await writeFile(join(home, RENDEZVOUS_FILE), content);
      expect(await readRendezvous(home), content).toBeUndefined();
    }
    // A newer writer's extra keys are not a reason to lose the host.
    await writeFile(join(home, RENDEZVOUS_FILE), JSON.stringify({ ...valid, later: true }));
    expect(await readRendezvous(home)).toEqual(valid);
    await writeFile(join(home, LAUNCH_PROVIDERS_FILE), JSON.stringify([{ id: 'x' }]));
    expect(await readLaunchProviders(home)).toBeUndefined();
    await rm(join(home, RENDEZVOUS_FILE));
    await mkdir(join(home, RENDEZVOUS_FILE));
    expect(await readRendezvous(home)).toBeUndefined();
  });

  it('refuses to publish what no shim could use, and publishes nothing', async () => {
    for (const options of [
      { port: 0, token: 'bearer' },
      { port: 70_000, token: 'bearer' },
      { port: 4242, token: '' },
      { port: 4242, token: 'x'.repeat(257) },
      { port: 4242, token: 'bearer', retryMs: -1 },
    ]) {
      await expect(
        writeRendezvous(home, { strict: false, launchProviders: providers, ...options }),
        JSON.stringify(options),
      ).rejects.toThrow();
    }
    await expect(
      writeRendezvous(home, {
        port: 4242,
        token: 'bearer',
        strict: false,
        launchProviders: [{ id: 'x' } as never],
      }),
    ).rejects.toThrow();
    await expect(readdir(home)).rejects.toThrow();
  });
});
