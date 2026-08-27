import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

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
});
