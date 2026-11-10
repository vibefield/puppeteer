import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHost } from '@vibefield/puppeteer-core';

// This file starts no process. `execFile` is read when the adapter's own helpers load, so it is a stub that throws.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(() => {
    throw new Error('this file starts no process');
  }),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));

import { TUI_GATEWAY_HOST_SOURCE } from '../generated/tui-gateway-host.js';
import { resolveHermesPython, startHermesGatewayHost, type StartHermesGatewayHostOptions } from './gateway-host.js';

/** An interpreter named outright, for the rows about everything but how the interpreter is found. */
const PYTHON = '/opt/hermes/venv/bin/python';

class FakeHostProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit', null, signal);
    });
    return true;
  });

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  /** Everything the adapter wrote to the host's stdin, once it ended the stream. */
  async stdinText(): Promise<string> {
    let text = '';
    for await (const chunk of this.stdin) text += String(chunk);
    return text;
  }

  ready(url: string): void {
    this.stdout.write(`${JSON.stringify({ url })}\n`);
  }
}

function spawnCall(index: number): { command: string; args: string[]; options: SpawnOptions } {
  const [command, args, options] = mocks.spawn.mock.calls[index] as [string, string[], SpawnOptions];
  return { command, args, options };
}

describe('Hermes gateway host launch', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('hands the host its bearer on stdin, never in argv or the environment', async () => {
    const child = new FakeHostProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const starting = startHermesGatewayHost({
      python: '/opt/hermes/venv/bin/python',
      hermesHome: '/tmp/hermes-home',
      cwd: '/work',
      env: { AI_PERSONA: 'hermes' },
    });
    const stdin = await child.stdinText();
    child.ready('ws://127.0.0.1:41234/api/ws');
    const host = await starting;
    try {
      expect(host.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(stdin).toBe(`${host.token}\n`);
      expect(host.url).toBe('ws://127.0.0.1:41234/api/ws');
      const { command, args, options } = spawnCall(0);
      expect(command).toBe('/opt/hermes/venv/bin/python');
      expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      expect(args.some((arg) => arg.includes(host.token))).toBe(false);
      expect(Object.values(options.env ?? {}).some((value) => value?.includes(host.token))).toBe(false);
    } finally {
      await host.close();
    }
  });

  it("runs under the session host's helper environment when the host composes one", async () => {
    const child = new FakeHostProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const helperEnvironment = vi.fn((env: Record<string, string>) => ({ PATH: '/agent/bin', ...env }));
    const starting = startHermesGatewayHost({
      python: PYTHON,
      hermesHome: '/tmp/hermes-home',
      cwd: '/work',
      env: { AI_PERSONA: 'hermes' },
      host: { helperEnvironment },
    });
    await child.stdinText();
    child.ready('ws://127.0.0.1:41234/api/ws');
    const host = await starting;
    try {
      // the adapter's own variables go through the host's policy, and nothing of this process's is merged back
      const own = { HERMES_HOME: '/tmp/hermes-home', HOME: '/tmp/hermes-home', AI_PERSONA: 'hermes' };
      expect(helperEnvironment).toHaveBeenCalledWith(own);
      expect(spawnCall(0).options.env).toEqual({ PATH: '/agent/bin', ...own });
    } finally {
      await host.close();
    }
  });

  it("keeps its minimal set, this process's PATH and the Hermes home, under a host that composes none", async () => {
    const child = new FakeHostProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const starting = startHermesGatewayHost({ python: PYTHON, hermesHome: '/tmp/hermes-home', cwd: '/work', host: {} });
    await child.stdinText();
    child.ready('ws://127.0.0.1:41234/api/ws');
    const host = await starting;
    try {
      expect(spawnCall(0).options.env).toEqual({
        PATH: process.env.PATH,
        HERMES_HOME: '/tmp/hermes-home',
        HOME: '/tmp/hermes-home',
      });
    } finally {
      await host.close();
    }
  });

  it('mints a different bearer for every host', async () => {
    const tokens: string[] = [];
    for (const port of [41234, 41235]) {
      const child = new FakeHostProcess();
      mocks.spawn.mockReturnValueOnce(child.asChildProcess());
      const starting = startHermesGatewayHost({ python: PYTHON, hermesHome: '/tmp/hermes-home', cwd: '/work' });
      await child.stdinText();
      child.ready(`ws://127.0.0.1:${port}/api/ws`);
      const host = await starting;
      tokens.push(host.token);
      await host.close();
    }
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('reports a host that died before it read its bearer by its exit, not a pipe error', async () => {
    const child = new FakeHostProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const starting = startHermesGatewayHost({ python: PYTHON, hermesHome: '/tmp/hermes-home', cwd: '/work' });
    child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await expect(starting).rejects.toThrow('Hermes gateway host exited (1)');
  });
});

describe("the gateway host's interpreter", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'puppeteer-hermes-interpreter-'));
    vi.stubEnv('HERMES_PYTHON', undefined);
    vi.stubEnv('PUPPETEER_HERMES_BIN', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    mocks.spawn.mockReset();
    await rm(scratch, { recursive: true, force: true });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  /** A `hermes` wrapper of the shape Hermes's installer writes, alone in a PATH directory. It is read, never run. */
  async function wrapperOnPath(): Promise<{ directory: string; python: string; checkout: string }> {
    const directory = join(scratch, 'bin');
    const checkout = join(scratch, 'hermes-agent');
    const python = join(checkout, 'venv', 'bin', 'python');
    await mkdir(directory);
    await writeFile(join(directory, 'hermes'), `#!/usr/bin/env bash\nexec "${python}" -m hermes_cli.main "$@"\n`, {
      mode: 0o755,
    });
    return { directory, python, checkout };
  }

  /** A host whose helper environment's PATH is the one directory given. */
  function pathOnly(directory: string): Pick<AgentHost, 'helperEnvironment'> {
    return { helperEnvironment: (env) => ({ PATH: directory, ...env }) };
  }

  /** What the host was spawned as, for a launch that starts. */
  async function spawned(
    options: Partial<StartHermesGatewayHostOptions>,
  ): Promise<{ command: string; args: string[] }> {
    const child = new FakeHostProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const starting = startHermesGatewayHost({ hermesHome: '/tmp/hermes-home', cwd: '/work', ...options });
    await child.stdinText();
    child.ready('ws://127.0.0.1:41234/api/ws');
    const host = await starting;
    await host.close();
    const { command, args } = spawnCall(mocks.spawn.mock.calls.length - 1);
    return { command, args };
  }

  it('runs the interpreter its hermes wrapper execs, when no python is given and HERMES_PYTHON is unset', async () => {
    const wrapper = await wrapperOnPath();
    expect((await spawned({ host: pathOnly(wrapper.directory) })).command).toBe(wrapper.python);
  });

  it('takes the explicit python first, then the wrapper, then HERMES_PYTHON', async () => {
    const wrapper = await wrapperOnPath();
    vi.stubEnv('HERMES_PYTHON', '/env/python');
    expect((await spawned({ python: '/explicit/python', host: pathOnly(wrapper.directory) })).command).toBe(
      '/explicit/python',
    );
    expect((await spawned({ host: pathOnly(wrapper.directory) })).command).toBe(wrapper.python);
    expect((await spawned({ host: pathOnly(join(scratch, 'empty')) })).command).toBe('/env/python');
  });

  it("hands the script the wrapper's checkout", async () => {
    const wrapper = await wrapperOnPath();
    expect((await spawned({ host: pathOnly(wrapper.directory) })).args.at(-1)).toBe(wrapper.checkout);
  });

  it('refuses a launch that names no interpreter and finds none, before anything is spawned', async () => {
    mocks.spawn.mockImplementation(() => {
      throw new Error('a refused launch spawns nothing');
    });
    await expect(
      startHermesGatewayHost({ hermesHome: '/tmp/hermes-home', cwd: '/work', host: pathOnly(join(scratch, 'empty')) }),
    ).rejects.toMatchObject({ name: 'AgentLaunchRefusedError', code: 'INTERPRETER_UNAVAILABLE' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  // A command line, not a file: nothing is written for the host to run, and -I keeps the agent's working directory,
  // PYTHONPATH and the user's site off its import path. The bearer still rides stdin alone (the first block's row).
  it.skipIf(process.platform === 'win32')(
    'runs the host script as -I -B -c with no file, and the checkout as its one argument',
    async () => {
      const wrapper = await wrapperOnPath();
      expect((await spawned({ host: pathOnly(wrapper.directory) })).args).toEqual([
        '-I',
        '-B',
        '-c',
        TUI_GATEWAY_HOST_SOURCE,
        wrapper.checkout,
      ]);
    },
  );

  it('hands over a checkout named beside a named python', async () => {
    const launched = await spawned({ python: PYTHON, checkout: '/opt/hermes', host: pathOnly(join(scratch, 'empty')) });
    expect({ command: launched.command, checkout: launched.args.at(-1) }).toEqual({
      command: PYTHON,
      checkout: '/opt/hermes',
    });
  });

  it("takes a named checkout in place of the wrapper's, and the wrapper's interpreter still", async () => {
    const wrapper = await wrapperOnPath();
    const launched = await spawned({ checkout: '/named/checkout', host: pathOnly(wrapper.directory) });
    expect({ command: launched.command, checkout: launched.args.at(-1) }).toEqual({
      command: wrapper.python,
      checkout: '/named/checkout',
    });
  });

  it("hands a named python no checkout it was not given, whatever wrapper is on the host's PATH", async () => {
    const wrapper = await wrapperOnPath();
    const launched = await spawned({ python: PYTHON, host: pathOnly(wrapper.directory) });
    expect(launched.args).not.toContain(wrapper.checkout);
  });

  it('keeps resolveHermesPython as it was: the explicit, then HERMES_PYTHON, then python3', () => {
    expect(resolveHermesPython('/explicit/python')).toBe('/explicit/python');
    vi.stubEnv('HERMES_PYTHON', '/env/python');
    expect(resolveHermesPython()).toBe('/env/python');
    vi.stubEnv('HERMES_PYTHON', undefined);
    expect(resolveHermesPython()).toBe('python3');
  });
});
