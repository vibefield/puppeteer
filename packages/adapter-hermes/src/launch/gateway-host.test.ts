import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { startHermesGatewayHost } from './gateway-host.js';

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

  it('mints a different bearer for every host', async () => {
    const tokens: string[] = [];
    for (const port of [41234, 41235]) {
      const child = new FakeHostProcess();
      mocks.spawn.mockReturnValueOnce(child.asChildProcess());
      const starting = startHermesGatewayHost({ hermesHome: '/tmp/hermes-home', cwd: '/work' });
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
    const starting = startHermesGatewayHost({ hermesHome: '/tmp/hermes-home', cwd: '/work' });
    child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await expect(starting).rejects.toThrow('Hermes gateway host exited (1)');
  });
});
