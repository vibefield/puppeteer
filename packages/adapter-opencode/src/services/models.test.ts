import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoopbackFetch, loopbackFetch } from '../transport/loopback-fetch.js';
import { readOpenCodeProviders } from './models.js';

vi.mock('../transport/loopback-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport/loopback-fetch.js')>();
  return { ...actual, loopbackFetch: vi.fn(actual.loopbackFetch) };
});

const catalog = { all: [], connected: [], default: {} };

describe('OpenCode provider catalog read', () => {
  let server: Server | undefined;

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  async function backend(): Promise<{ origin: string; username: string; password: string; seen: string[] }> {
    const seen: string[] = [];
    server = createServer((request, response) => {
      seen.push(`${request.method} ${request.url} ${request.headers.authorization}`);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(catalog));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server!.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, username: 'opencode', password: 'secret', seen };
  }

  it('reads /provider through the loopback fetch by default', async () => {
    const target = await backend();
    expect(await readOpenCodeProviders(target, '/work/repo', undefined)).toEqual(catalog);
    expect(vi.mocked(loopbackFetch)).toHaveBeenCalledOnce();
    expect(target.seen).toEqual([
      `GET /provider?directory=%2Fwork%2Frepo Basic ${Buffer.from('opencode:secret').toString('base64')}`,
    ]);
  });

  it("survives a predecessor's stale pooled socket on the reused origin", async () => {
    const target = await backend();
    const pooled = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }),
      )
      .mockImplementation((input, init) => fetch(input, init));
    const signal = AbortSignal.timeout(5_000);
    const document = await readOpenCodeProviders(target, '/work/repo', signal, createLoopbackFetch({ pooled }));
    expect(document).toEqual(catalog);
    expect(pooled).toHaveBeenCalledTimes(2);
    expect(pooled.mock.calls[0]?.[1]?.signal).toBe(signal);
    expect(target.seen).toHaveLength(1);
  });
});
