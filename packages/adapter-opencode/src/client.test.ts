import { describe, expect, it, vi } from 'vitest';
import { OpenCodeClient, OpenCodeHttpError } from './client.js';

describe('OpenCodeClient', () => {
  it('routes the directory and Basic credentials without putting the secret in the URL', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/session/status');
      expect(url.searchParams.get('directory')).toBe('/workspace/project');
      expect(url.href).not.toContain('secret');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Basic ${Buffer.from('opencode:secret').toString('base64')}`,
      );
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const client = new OpenCodeClient({
      origin: 'http://127.0.0.1:1234',
      directory: '/workspace/project',
      username: 'opencode',
      password: 'secret',
      fetchImpl,
    });

    await expect(client.getStatuses()).resolves.toEqual({});
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('treats prompt_async 204 as accepted transport, not a confirmation receipt', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    const client = new OpenCodeClient({
      origin: 'http://127.0.0.1:1234',
      directory: '/workspace',
      username: 'opencode',
      password: 'secret',
      fetchImpl,
    });
    await expect(
      client.submitPrompt('ses_1', { messageID: 'msg_exact', parts: [{ type: 'text', text: 'hello' }] }),
    ).resolves.toBeUndefined();
  });

  it('returns bounded status-bearing errors', async () => {
    const client = new OpenCodeClient({
      origin: 'http://127.0.0.1:1234',
      directory: '/workspace',
      username: 'opencode',
      password: 'wrong',
      fetchImpl: vi.fn(async () => new Response('unauthorized', { status: 401 })) as typeof fetch,
    });
    await expect(client.getStatuses()).rejects.toMatchObject({ status: 401 } satisfies Partial<OpenCodeHttpError>);
  });
});
