import { describe, expect, it, vi } from 'vitest';
import { withStaleSocketRetry } from './loopback-fetch.js';

function socketFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(`read ${code}`), { code }) });
}

describe('withStaleSocketRetry', () => {
  it('retries a pre-response stale pooled socket once on a fresh connection', async () => {
    const inner = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(socketFailure('ECONNRESET'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const response = await withStaleSocketRetry(inner)('http://127.0.0.1:4096/event', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner.mock.calls[1]).toEqual(inner.mock.calls[0]);
  });

  it('surfaces a second consecutive socket failure instead of looping', async () => {
    const inner = vi.fn<typeof fetch>().mockRejectedValue(socketFailure('UND_ERR_SOCKET'));
    await expect(withStaleSocketRetry(inner)('http://127.0.0.1:4096/session', { method: 'POST' })).rejects.toThrow(
      'fetch failed',
    );
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('does not retry refused connections, other failures, or aborted requests', async () => {
    for (const failure of [socketFailure('ECONNREFUSED'), new Error('boom')]) {
      const inner = vi.fn<typeof fetch>().mockRejectedValue(failure);
      await expect(withStaleSocketRetry(inner)('http://127.0.0.1:4096/session')).rejects.toBe(failure);
      expect(inner).toHaveBeenCalledOnce();
    }
    const controller = new AbortController();
    controller.abort();
    const inner = vi.fn<typeof fetch>().mockRejectedValue(socketFailure('ECONNRESET'));
    await expect(
      withStaleSocketRetry(inner)('http://127.0.0.1:4096/event', { signal: controller.signal }),
    ).rejects.toThrow('fetch failed');
    expect(inner).toHaveBeenCalledOnce();
  });

  it('passes HTTP error responses through without retrying', async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 401 }));
    expect((await withStaleSocketRetry(inner)('http://127.0.0.1:4096/session')).status).toBe(401);
    expect(inner).toHaveBeenCalledOnce();
  });
});
