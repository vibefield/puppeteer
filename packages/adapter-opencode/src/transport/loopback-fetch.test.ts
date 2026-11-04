import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoopbackFetch, freshConnectionFetch, loopbackFetch } from './loopback-fetch.js';

function socketFailure(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(`read ${code}`), { code }) });
}

describe('createLoopbackFetch', () => {
  it('retries an idempotent request once after a stale pooled socket', async () => {
    for (const method of ['GET', 'HEAD', undefined]) {
      const pooled = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(socketFailure('ECONNRESET'))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      const fresh = vi.fn<typeof fetch>();
      const init = method === undefined ? undefined : { method };
      const response = await createLoopbackFetch({ pooled, fresh })('http://127.0.0.1:4096/event', init);
      expect(response.status).toBe(200);
      expect(pooled).toHaveBeenCalledTimes(2);
      expect(pooled.mock.calls[1]).toEqual(pooled.mock.calls[0]);
      expect(fresh).not.toHaveBeenCalled();
    }
  });

  it('surfaces a second consecutive idempotent socket failure instead of looping', async () => {
    const pooled = vi.fn<typeof fetch>().mockRejectedValue(socketFailure('UND_ERR_SOCKET'));
    await expect(createLoopbackFetch({ pooled })('http://127.0.0.1:4096/session/status')).rejects.toThrow(
      'fetch failed',
    );
    expect(pooled).toHaveBeenCalledTimes(2);
  });

  it('sends every non-idempotent request once on its own connection, never through the pool', async () => {
    for (const method of ['POST', 'post', 'PUT', 'PATCH', 'DELETE']) {
      const pooled = vi.fn<typeof fetch>();
      const fresh = vi.fn<typeof fetch>().mockRejectedValue(socketFailure('ECONNRESET'));
      await expect(
        createLoopbackFetch({ pooled, fresh })('http://127.0.0.1:4096/session/ses_1/prompt_async', {
          method,
          body: '{}',
        }),
      ).rejects.toThrow('fetch failed');
      expect(fresh).toHaveBeenCalledOnce();
      expect(pooled).not.toHaveBeenCalled();
    }
  });

  it('reads the method from a Request input', async () => {
    const pooled = vi.fn<typeof fetch>();
    const fresh = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const request = new Request('http://127.0.0.1:4096/session', { method: 'POST', body: '{}' });
    expect((await createLoopbackFetch({ pooled, fresh })(request)).status).toBe(204);
    expect(fresh).toHaveBeenCalledOnce();
    expect(pooled).not.toHaveBeenCalled();
  });

  it('does not retry refused connections, other failures, or aborted requests', async () => {
    for (const failure of [socketFailure('ECONNREFUSED'), new Error('boom')]) {
      const pooled = vi.fn<typeof fetch>().mockRejectedValue(failure);
      await expect(createLoopbackFetch({ pooled })('http://127.0.0.1:4096/session')).rejects.toBe(failure);
      expect(pooled).toHaveBeenCalledOnce();
    }
    const controller = new AbortController();
    controller.abort();
    const pooled = vi.fn<typeof fetch>().mockRejectedValue(socketFailure('ECONNRESET'));
    await expect(
      createLoopbackFetch({ pooled })('http://127.0.0.1:4096/event', { signal: controller.signal }),
    ).rejects.toThrow('fetch failed');
    expect(pooled).toHaveBeenCalledOnce();
  });

  it('passes HTTP error responses through without retrying', async () => {
    const pooled = vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 401 }));
    expect((await createLoopbackFetch({ pooled })('http://127.0.0.1:4096/session')).status).toBe(401);
    expect(pooled).toHaveBeenCalledOnce();
  });
});

describe('loopbackFetch against a real loopback server', () => {
  let server: Server | undefined;

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  async function serve(handler: (request: IncomingMessage, body: string, response: ServerResponse) => void) {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => handler(request, Buffer.concat(chunks).toString('utf8'), response));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('does not send a POST twice when the backend resets after receiving it', async () => {
    const received: string[] = [];
    const origin = await serve((request, body, response) => {
      received.push(`${request.method} ${request.url} ${body}`);
      // The backend read the prompt and then died before answering.
      response.socket?.destroy();
    });
    await expect(
      loopbackFetch(`${origin}/session/ses_1/prompt_async`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"messageID":"msg_1"}',
      }),
    ).rejects.toThrow('fetch failed');
    expect(received).toEqual(['POST /session/ses_1/prompt_async {"messageID":"msg_1"}']);
  });

  it('re-sends an idempotent GET after the backend reset it', async () => {
    let requests = 0;
    const origin = await serve((_request, _body, response) => {
      requests += 1;
      if (requests === 1) {
        response.socket?.destroy();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    const response = await loopbackFetch(`${origin}/session/status`);
    expect(await response.json()).toEqual({});
    expect(requests).toBe(2);
  });

  it('carries the method, headers, body, status and response body on a fresh connection', async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const origin = await serve((request, body, response) => {
      seen.push({
        method: request.method,
        type: request.headers['content-type'],
        authorization: request.headers.authorization,
        connection: request.headers.connection,
        body,
      });
      if (request.url === '/empty') response.writeHead(204).end();
      else response.writeHead(201, { 'content-type': 'application/json' }).end('{"id":"ses_1"}');
    });
    const created = await freshConnectionFetch(`${origin}/session`, {
      method: 'POST',
      headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
      body: '{"title":"t"}',
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('content-type')).toBe('application/json');
    expect(await created.json()).toEqual({ id: 'ses_1' });
    const empty = await freshConnectionFetch(`${origin}/empty`, { method: 'POST' });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
    expect(seen[0]).toEqual({
      method: 'POST',
      type: 'application/json',
      authorization: 'Basic abc',
      connection: 'close',
      body: '{"title":"t"}',
    });
    expect(seen[1]).toMatchObject({ method: 'POST', body: '' });
  });

  it('rejects with the abort reason when the caller aborts', async () => {
    const origin = await serve(() => {
      // Never answers.
    });
    const controller = new AbortController();
    const pending = freshConnectionFetch(`${origin}/session`, { method: 'POST', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
