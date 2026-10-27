import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A taskkill mock that never answers would hang dispose; the default answers at once.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn((_file: string, _args: string[], _options: object, callback?: () => void) => callback?.()),
}));

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

// Dispose ends a POSIX child with signals and a Windows tree with taskkill, so each test names the platform
// it exercises and the suite behaves the same on every host (the Windows CI job included).
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function runAs(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
}

describe('spawnAppServer process contract', () => {
  beforeEach(() => runAs('linux'));
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    vi.clearAllMocks();
  });

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

  it('runs under exactly the environment it is handed when told not to inherit this process’s own', async () => {
    vi.stubEnv('PUPPETEER_HOST_ONLY_SECRET', 'host-secret');
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    const server = spawnAppServer({
      executable: 'codex-test',
      transport: 'websocket',
      env: { PATH: '/agent/bin', CODEX_HOME: '/isolated-codex' },
      inheritEnvironment: false,
    });
    try {
      const spawnOptions = mocks.spawn.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env).toEqual({ PATH: '/agent/bin', CODEX_HOME: '/isolated-codex' });
      expect(spawnOptions.env).not.toHaveProperty('PUPPETEER_HOST_ONLY_SECRET');
    } finally {
      await server.dispose();
      vi.unstubAllEnvs();
    }
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
    runAs('win32');
    const child = new FakeChildProcess();
    mocks.spawn.mockReturnValue(child.asChildProcess());
    mocks.execFile.mockImplementationOnce((_file: string, _args: string[], _options: object, callback?: () => void) => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
        callback?.();
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
  });
});
