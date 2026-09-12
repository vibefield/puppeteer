import { describe, expect, it, vi } from 'vitest';
import type { Transport } from '../transport/app-server-client.js';
import { prewarmCodex } from './prewarm.js';

function server(stall = false, fail = false) {
  let receive: (message: unknown) => void = () => undefined;
  const methods: string[] = [];
  const close = vi.fn();
  const transport: Transport = {
    send(message) {
      const request = message as { id?: number; method: string };
      methods.push(request.method);
      if (request.id === undefined || stall) return;
      queueMicrotask(() =>
        receive({
          id: request.id,
          ...(fail ? { error: { code: -1, message: 'unavailable' } } : { result: { data: [] } }),
        }),
      );
    },
    onMessage(handler) {
      receive = handler;
    },
    onClose() {},
    close,
  };
  return { methods, close, spawnTransport: vi.fn(() => transport) };
}

describe('Codex cache prewarming', () => {
  it('warms the bound native catalog without creating a thread or turn and closes the helper', async () => {
    const fake = server();
    await prewarmCodex({
      executable: '/opt/codex',
      env: { CODEX_HOME: '/profiles/one' },
      spawnTransport: fake.spawnTransport,
    });
    expect(fake.spawnTransport).toHaveBeenCalledWith({
      executable: '/opt/codex',
      env: { CODEX_HOME: '/profiles/one' },
    });
    expect(fake.methods).toEqual(['initialize', 'initialized', 'model/list']);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('closes the helper when initialization fails', async () => {
    const fake = server(false, true);
    await expect(prewarmCodex({ spawnTransport: fake.spawnTransport })).rejects.toThrow('unavailable');
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('cancels a stalled request on shutdown', async () => {
    const fake = server(true);
    const controller = new AbortController();
    const warming = prewarmCodex({ signal: controller.signal, spawnTransport: fake.spawnTransport });
    const rejected = expect(warming).rejects.toThrow('client closed');
    controller.abort();
    await rejected;
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('bounds the background request even when the server never answers', async () => {
    const fake = server(true);
    await expect(prewarmCodex({ timeoutMs: 20, spawnTransport: fake.spawnTransport })).rejects.toThrow('client closed');
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('does not spawn after cancellation or with an invalid budget', async () => {
    const fake = server();
    await expect(prewarmCodex({ signal: AbortSignal.abort(), spawnTransport: fake.spawnTransport })).rejects.toThrow();
    await expect(prewarmCodex({ timeoutMs: -1, spawnTransport: fake.spawnTransport })).rejects.toThrow();
    expect(fake.spawnTransport).not.toHaveBeenCalled();
  });
});
