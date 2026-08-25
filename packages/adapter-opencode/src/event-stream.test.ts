import { describe, expect, it, vi } from 'vitest';
import { OpenCodeClient } from './client.js';
import { OpenCodeEventStream, OpenCodeSseDecoder, type OpenCodeSseRecord } from './event-stream.js';

function sseResponse(records: unknown[], stayOpen = false): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const record of records) controller.enqueue(encoder.encode(`data: ${JSON.stringify(record)}\n\n`));
        if (!stayOpen) controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('OpenCode SSE transport', () => {
  it('decodes split and multiline SSE data blocks exactly', () => {
    const decoder = new OpenCodeSseDecoder();
    expect(decoder.feed('data: {"id":"evt_1",\n')).toEqual([]);
    expect(decoder.feed('data: "type":"x"}\n\n')).toEqual(['{"id":"evt_1",\n"type":"x"}']);
  });

  it('reconnects without pretending the stream replayed history', async () => {
    const connected = { id: 'evt_connected', type: 'server.connected', properties: {} };
    const target = { id: 'evt_target', type: 'future.event', properties: { sessionID: 'ses_1' } };
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? sseResponse([connected]) : sseResponse([connected, target], true);
    }) as typeof fetch;
    const client = new OpenCodeClient({
      origin: 'http://127.0.0.1:1234',
      directory: '/workspace',
      username: 'opencode',
      password: 'secret',
      fetchImpl,
    });
    const opens: boolean[] = [];
    const records: OpenCodeSseRecord[] = [];
    let resolveTarget!: () => void;
    const sawTarget = new Promise<void>((resolve) => {
      resolveTarget = resolve;
    });
    const stream = new OpenCodeEventStream({
      client,
      fetchImpl,
      reconnectDelayMs: 1,
      onOpen: ({ reconnect }) => {
        opens.push(reconnect);
      },
      onRecord(record) {
        records.push(record);
        if (record.id === target.id) resolveTarget();
      },
    });

    await stream.start();
    await sawTarget;
    await stream.stop();
    expect(opens).toEqual([false, true]);
    expect(records.map((record) => record.id)).toEqual(['evt_connected', 'evt_connected', 'evt_target']);
  });

  it('retains malformed data through the explicit malformed callback', async () => {
    const fetchImpl = vi.fn(async () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {bad json}\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    const client = new OpenCodeClient({
      origin: 'http://127.0.0.1:1234',
      directory: '/workspace',
      username: 'opencode',
      password: 'secret',
      fetchImpl,
    });
    let resolveMalformed!: () => void;
    const malformed = new Promise<void>((resolve) => {
      resolveMalformed = resolve;
    });
    const stream = new OpenCodeEventStream({
      client,
      fetchImpl,
      onRecord() {},
      onMalformed(data) {
        expect(data).toBe('{bad json}');
        resolveMalformed();
      },
    });
    await stream.start();
    await malformed;
    await stream.stop();
  });
});
