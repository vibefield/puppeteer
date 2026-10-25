import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));

import { spawnAppServer } from './app-server-process.js';

class FakeChildProcess extends EventEmitter {
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
}

describe('spawnAppServer process contract', () => {
  afterEach(() => vi.clearAllMocks());

  it('observes a bound Unix socket on a native wakeup without waiting for the poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const root = mkdtempSync(join(tmpdir(), 'codex-ready-'));
    const socketPath = join(root, 'server.sock');
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const server = spawnAppServer({ executable: 'codex-test', transport: 'unix', socketPath });
    try {
      child.stderr.write('before bind');
      expect(() => server.endpoint()).toThrow('before ready');
      writeFileSync(socketPath, 'fixture');
      child.stderr.write('after bind');
      await server.ready();
      expect(server.endpoint()).toEqual({ kind: 'unix', path: socketPath });
    } finally {
      await server.dispose();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains polling readiness when the native Unix server is silent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const root = mkdtempSync(join(tmpdir(), 'codex-ready-quiet-'));
    const socketPath = join(root, 'server.sock');
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const server = spawnAppServer({ executable: 'codex-test', transport: 'unix', socketPath });
    try {
      writeFileSync(socketPath, 'fixture');
      await vi.advanceTimersByTimeAsync(50);
      expect(server.endpoint()).toEqual({ kind: 'unix', path: socketPath });
    } finally {
      await server.dispose();
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('discovers an ephemeral loopback endpoint from a split startup banner', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const server = spawnAppServer({
      executable: 'codex-test.exe',
      transport: 'websocket',
      env: { CODEX_HOME: 'C:\\isolated-codex' },
    });

    expect(() => server.endpoint()).toThrow('before ready');
    expect(mocks.spawn).toHaveBeenCalledWith(
      'codex-test.exe',
      ['app-server', '--listen', 'ws://127.0.0.1:0'],
      expect.objectContaining({
        stdio: ['ignore', 'ignore', 'pipe'],
        env: expect.objectContaining({ CODEX_HOME: 'C:\\isolated-codex' }),
      }),
    );

    child.stderr.write('codex app-server (WebSockets)\n  listen');
    child.stderr.write('ing on: ws://127.0.0.1:60421\n');
    await server.ready();
    expect(server.endpoint()).toEqual({ kind: 'websocket', url: 'ws://127.0.0.1:60421' });

    await Promise.all([server.dispose(), server.dispose()]);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('includes app-server diagnostics when the process exits before readiness', async () => {
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const server = spawnAppServer({ executable: 'codex-test', transport: 'websocket' });
    const ready = server.ready();

    child.stderr.write('configuration could not be loaded');
    child.exitCode = 2;
    child.emit('exit', 2, null);

    await expect(ready).rejects.toThrow(/exited before ready.*configuration could not be loaded/s);
    await server.dispose();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('ends the whole process tree on Windows, where kill() would leave the app-server helpers running', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const child = new FakeChildProcess();
      mocks.spawn.mockReturnValue(child.asChildProcess());
      mocks.execFile.mockImplementation((_file: string, _args: string[], _options: object, callback: () => void) => {
        queueMicrotask(() => {
          child.exitCode = 1;
          child.emit('exit', 1, null);
          callback();
        });
      });
      const server = spawnAppServer({ executable: 'codex-test', transport: 'websocket' });
      await server.dispose();
      expect(mocks.execFile).toHaveBeenCalledOnce();
      expect(mocks.execFile).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '4242', '/T', '/F'],
        { windowsHide: true },
        expect.any(Function),
      );
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
