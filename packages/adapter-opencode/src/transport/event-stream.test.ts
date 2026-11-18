import { describe, expect, it, vi } from 'vitest';
import { OpenCodeClient } from './client.js';
import {
  OPENCODE_1_SSE_ENVELOPE,
  OpenCodeEventStream,
  OpenCodeSseDecoder,
  parseOpenCodeSseRecord,
  type OpenCodeSseEnvelope,
  type OpenCodeSseRecord,
  type OpenCodeSseSequenceGap,
} from './event-stream.js';

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

  function client(fetchImpl: typeof fetch): OpenCodeClient {
    return new OpenCodeClient({
      origin: 'http://127.0.0.1:1234',
      directory: '/workspace',
      username: 'opencode',
      password: 'secret',
      fetchImpl,
    });
  }

  // The shape 2.2.5 sends (probe 2026-11-04): payload under `data`, an object on the wire although the schema
  // declares an encoded string, and a per-session `durable` stamp.
  const dataEnvelope: OpenCodeSseEnvelope = { payloadKey: 'data', encodedPayload: true, durableKey: 'durable' };

  it('parses the 1.x envelope exactly as before and ignores keys it does not name', () => {
    const record = { id: 'evt_1', type: 'session.idle', properties: { sessionID: 'ses_1' }, durable: { x: 1 } };
    expect(parseOpenCodeSseRecord(JSON.stringify(record))).toEqual({
      id: 'evt_1',
      type: 'session.idle',
      properties: { sessionID: 'ses_1' },
    });
    expect(parseOpenCodeSseRecord(JSON.stringify(record), OPENCODE_1_SSE_ENVELOPE)).not.toHaveProperty('durable');
    expect(() => parseOpenCodeSseRecord('{"id":"evt_1","type":"x","properties":"{}"}')).toThrow(
      'OpenCode SSE record properties must be an object',
    );
    expect(() => parseOpenCodeSseRecord('{"id":"evt_1","type":"x","data":{}}')).toThrow(
      'OpenCode SSE record properties must be an object',
    );
  });

  it('reads a payload under another key, as an object or an encoded string, with its durable stamp', () => {
    const durable = { aggregateID: 'ses_1', seq: 3, version: 1 };
    expect(
      parseOpenCodeSseRecord(
        JSON.stringify({ id: 'evt_1', type: 'session.renamed', created: 1, data: { title: 't' }, durable }),
        dataEnvelope,
      ),
    ).toEqual({ id: 'evt_1', type: 'session.renamed', properties: { title: 't' }, durable });
    expect(
      parseOpenCodeSseRecord(JSON.stringify({ id: 'evt_2', type: 'server.connected', data: '{"a":1}' }), dataEnvelope),
    ).toEqual({ id: 'evt_2', type: 'server.connected', properties: { a: 1 } });
    expect(() => parseOpenCodeSseRecord(JSON.stringify({ id: 'evt_3', type: 'x', data: '[1]' }), dataEnvelope)).toThrow(
      'OpenCode SSE record data must be an object',
    );
    expect(() =>
      parseOpenCodeSseRecord(JSON.stringify({ id: 'evt_4', type: 'x', data: '{}' }), {
        payloadKey: 'data',
        encodedPayload: false,
      }),
    ).toThrow('OpenCode SSE record data must be an object');
    expect(() =>
      parseOpenCodeSseRecord(
        JSON.stringify({ id: 'evt_5', type: 'x', data: {}, durable: { aggregateID: 'ses_1', seq: -1, version: 1 } }),
        dataEnvelope,
      ),
    ).toThrow('durable stamp');
  });

  it('subscribes on the given path with one repeated types parameter per type', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return sseResponse([{ id: 'evt_c', type: 'server.connected', data: {} }], true);
    }) as typeof fetch;
    const records: OpenCodeSseRecord[] = [];
    let resolveRecord!: () => void;
    const sawRecord = new Promise<void>((resolve) => {
      resolveRecord = resolve;
    });
    const stream = new OpenCodeEventStream({
      client: client(fetchImpl),
      fetchImpl,
      envelope: dataEnvelope,
      path: '/api/event',
      types: ['session.created', 'permission.asked'],
      onRecord(record) {
        records.push(record);
        resolveRecord();
      },
    });
    await stream.start();
    await sawRecord;
    await stream.stop();
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe('/api/event');
    expect(url.searchParams.getAll('types')).toEqual(['session.created', 'permission.asked']);
    expect(url.searchParams.get('directory')).toBe('/workspace');
    expect(records[0]).toEqual({ id: 'evt_c', type: 'server.connected', properties: {} });
  });

  it('keeps the 1.x subscription URL when no path or types are given', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(client(fetchImpl).eventUrl()).toBe('http://127.0.0.1:1234/event?directory=%2Fworkspace');
  });

  it('calls the gap hook before the record that skipped ahead, within a connection and across a reconnect', async () => {
    const stamp = (aggregateID: string, seq: number) => ({
      id: `evt_${aggregateID}_${seq}`,
      type: 'session.renamed',
      data: {},
      durable: { aggregateID, seq, version: 1 },
    });
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      // First connection: ses_a 0,1, then 3 (2 lost); ses_b 5 (a starting point); a duplicate 1.
      // Second connection: ses_a 4 (in order across the reconnect), ses_b 9 (6–8 missed while disconnected).
      return calls === 1
        ? sseResponse([stamp('ses_a', 0), stamp('ses_a', 1), stamp('ses_a', 3), stamp('ses_b', 5), stamp('ses_a', 1)])
        : sseResponse([stamp('ses_a', 4), stamp('ses_b', 9)], true);
    }) as typeof fetch;
    const order: string[] = [];
    const gaps: Omit<OpenCodeSseSequenceGap, 'record'>[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const stream = new OpenCodeEventStream({
      client: client(fetchImpl),
      fetchImpl,
      reconnectDelayMs: 1,
      envelope: dataEnvelope,
      async onSequenceGap({ record, ...gap }) {
        order.push(`gap:${record.id}`);
        gaps.push(gap);
      },
      onRecord(record) {
        order.push(record.id);
        if (record.id === 'evt_ses_b_9') resolveDone();
      },
    });
    await stream.start();
    await done;
    await stream.stop();
    expect(gaps).toEqual([
      { aggregateID: 'ses_a', expected: 2, received: 3, acrossReconnect: false },
      { aggregateID: 'ses_b', expected: 6, received: 9, acrossReconnect: true },
    ]);
    expect(order).toEqual([
      'evt_ses_a_0',
      'evt_ses_a_1',
      'gap:evt_ses_a_3',
      'evt_ses_a_3',
      'evt_ses_b_5',
      'evt_ses_a_1',
      'evt_ses_a_4',
      'gap:evt_ses_b_9',
      'evt_ses_b_9',
    ]);
  });

  it('keeps a gap that its hook failed to handle, so the reconnect reports it again', async () => {
    const stamp = (seq: number) => ({
      id: `evt_${seq}`,
      type: 'session.renamed',
      data: {},
      durable: { aggregateID: 'ses_a', seq, version: 1 },
    });
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      // First connection: 0, then 2 (1 lost) and the hook fails. Second connection: 3 arrives after the reconnect.
      return calls === 1 ? sseResponse([stamp(0), stamp(2)], true) : sseResponse([stamp(3)], true);
    }) as typeof fetch;
    const gaps: Omit<OpenCodeSseSequenceGap, 'record'>[] = [];
    const delivered: string[] = [];
    const errors: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const stream = new OpenCodeEventStream({
      client: client(fetchImpl),
      fetchImpl,
      reconnectDelayMs: 1,
      envelope: dataEnvelope,
      onSequenceGap({ record: _record, ...gap }) {
        gaps.push(gap);
        if (gaps.length === 1) throw new Error('rehydrate failed');
      },
      onRecord(record) {
        delivered.push(record.id);
        if (record.id === 'evt_3') resolveDone();
      },
      onError(error) {
        errors.push(error.message);
      },
    });
    await stream.start();
    await done;
    await stream.stop();
    expect(errors).toEqual(['rehydrate failed']);
    // The failed record is not delivered, and the mark stayed at 0: the next record reports the gap from 1 again.
    expect(delivered).toEqual(['evt_0', 'evt_3']);
    expect(gaps).toEqual([
      { aggregateID: 'ses_a', expected: 1, received: 2, acrossReconnect: false },
      { aggregateID: 'ses_a', expected: 1, received: 3, acrossReconnect: true },
    ]);
  });

  it('refuses a gap hook on an envelope that names no durable stamp', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(() => new OpenCodeEventStream({ client: client(fetchImpl), onRecord() {}, onSequenceGap() {} })).toThrow(
      'durable key',
    );
  });
});
