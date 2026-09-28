import { once } from 'node:events';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSpawnThroughGateway, type SpawnThroughGateway } from './gateway.js';
import type { SpawnThroughRequest, SpawnThroughResponse } from './protocol.js';

const request: SpawnThroughRequest = {
  type: 'launch',
  token: 'secret',
  providerId: 'example',
  cwd: '/repo',
  argv: [],
  environment: {},
  pid: 456,
  parentPid: 123,
  interactive: true,
};

/** One connection, as the shim makes it: write, then read one line. */
async function ask(port: number, payload: string): Promise<SpawnThroughResponse> {
  const socket = connect(port, '127.0.0.1');
  socket.setEncoding('utf8');
  let response = '';
  socket.on('data', (chunk: string) => {
    response += chunk;
  });
  await once(socket, 'connect');
  socket.write(payload);
  await once(socket, 'close');
  return JSON.parse(response.trim()) as SpawnThroughResponse;
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

let gateway: SpawnThroughGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

describe('spawn-through gateway', () => {
  it('hands an authenticated, parsed request to the host and answers with its verdict', async () => {
    const handle = vi.fn(async (): Promise<SpawnThroughResponse> => ({
      action: 'exec',
      preparationId: 'p-1',
      launch: { command: '/managed', args: ['--a'], cwd: '/repo' },
    }));
    gateway = await startSpawnThroughGateway({ token: 'secret', handle });
    expect(gateway.port).toBeGreaterThan(0);

    await expect(ask(gateway.port, line(request))).resolves.toEqual({
      action: 'exec',
      preparationId: 'p-1',
      launch: { command: '/managed', args: ['--a'], cwd: '/repo' },
    });
    expect(handle).toHaveBeenCalledWith(request);
  });

  it('answers a wrong bearer, a malformed request, an oversize one and a throwing handler with fallback', async () => {
    const handle = vi.fn(async (): Promise<SpawnThroughResponse> => {
      throw new Error('the runtime is disposed');
    });
    gateway = await startSpawnThroughGateway({ token: 'secret', handle });

    const unauthenticated = {
      action: 'fallback',
      code: 'unauthenticated',
      reason: 'spawn-through authentication failed',
    };
    await expect(ask(gateway.port, line({ ...request, token: 'guess' }))).resolves.toEqual(unauthenticated);
    await expect(ask(gateway.port, line({ ...request, unknown: true }))).resolves.toEqual(unauthenticated);
    // A line that is not JSON at all tells the caller no more than a wrong bearer does.
    await expect(ask(gateway.port, 'not json\n')).resolves.toEqual(unauthenticated);
    expect(handle).not.toHaveBeenCalled();
    await expect(ask(gateway.port, `${'x'.repeat(64 * 1024 + 1)}`)).resolves.toEqual({
      action: 'fallback',
      code: 'request-too-large',
      reason: 'spawn-through request is too large',
    });
    await expect(ask(gateway.port, line(request))).resolves.toEqual({
      action: 'fallback',
      code: 'handler-failed',
      reason: 'the runtime is disposed',
    });
  });

  it('refuses instead when the host is strict, so no failure of its own lets a launch through', async () => {
    gateway = await startSpawnThroughGateway({
      token: 'secret',
      strict: true,
      handle: async () => {
        throw new Error('the runtime is disposed');
      },
    });
    await expect(ask(gateway.port, line({ ...request, token: 'guess' }))).resolves.toEqual({
      action: 'refuse',
      code: 'unauthenticated',
      reason: 'spawn-through authentication failed',
      message: 'not started, because it could not be run as a managed session: spawn-through authentication failed',
    });
    await expect(ask(gateway.port, line(request))).resolves.toMatchObject({
      action: 'refuse',
      code: 'handler-failed',
      reason: 'the runtime is disposed',
    });
  });

  it('closes promptly even when a client leaves an incomplete request open', async () => {
    gateway = await startSpawnThroughGateway({ token: 'secret', handle: async () => ({ action: 'ack' }) });
    const socket = connect(gateway.port, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write('{"token":"secret"');
    // Not `once`: the destroyed connection may reach the client as a reset, which `once` would reject on.
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

    await expect(gateway.close()).resolves.toBeUndefined();
    await closed;
  });

  it('survives a client that resets its connection before the answer, and keeps answering', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    gateway = await startSpawnThroughGateway({
      token: 'secret',
      handle: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return { action: 'ack' };
      },
    });
    const socket = connect(gateway.port, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write(line(request));
    await vi.waitFor(() => expect(calls).toBe(1));
    socket.resetAndDestroy();
    await once(socket, 'close');
    // The answer now meets a reset socket; the host must hear the error, not die of it.
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(ask(gateway.port, line(request))).resolves.toEqual({ action: 'ack' });
  });
});
