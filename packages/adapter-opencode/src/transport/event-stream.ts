/** Exact OpenCode SSE framing, reconnect, and bounded malformed-record handling. */

import type { OpenCodeClient } from './client.js';
import { loopbackFetch } from './loopback-fetch.js';

/** A per-aggregate ordering stamp an envelope may carry (`durable: {aggregateID, seq, version}`). */
export interface OpenCodeSseDurable {
  aggregateID: string;
  seq: number;
  version: number;
}

export interface OpenCodeSseRecord {
  id: string;
  type: string;
  /** The event's payload, read from the envelope's payload key whatever that key is named on the wire. */
  properties: Record<string, unknown>;
  /** Present only when the envelope names a durable key and the record carries one. */
  durable?: OpenCodeSseDurable;
}

/**
 * Where a record keeps its payload and ordering. 1.x is `{id, type, properties}` with `properties` an object; a
 * line whose schema declares an encoded-string payload but sends an object sets `encodedPayload` to accept both.
 */
export interface OpenCodeSseEnvelope {
  readonly payloadKey: string;
  /** Also accept the payload as a JSON string that decodes to an object. */
  readonly encodedPayload: boolean;
  /** The key of an optional per-aggregate `{aggregateID, seq, version}` stamp; absent: never read. */
  readonly durableKey?: string | undefined;
}

/** OpenCode 1.x: `{id, type, properties}`, `properties` an object, no ordering stamp. */
export const OPENCODE_1_SSE_ENVELOPE: OpenCodeSseEnvelope = Object.freeze({
  payloadKey: 'properties',
  encodedPayload: false,
});

/**
 * A per-aggregate `seq` that skipped ahead of the last one this stream saw. The stream has no replay cursor, so the
 * records in between are lost to it; the consumer rehydrates the aggregate over REST.
 */
export interface OpenCodeSseSequenceGap {
  aggregateID: string;
  /** The seq that should have come next. */
  expected: number;
  received: number;
  /** True when the gap spans a reconnect, false when records went missing inside one connection. */
  acrossReconnect: boolean;
  record: OpenCodeSseRecord;
}

export interface OpenCodeEventStreamOptions {
  client: OpenCodeClient;
  onOpen?: ((context: { reconnect: boolean }) => void | Promise<void>) | undefined;
  onRecord: (record: OpenCodeSseRecord) => void | Promise<void>;
  onMalformed?: ((data: string, error: Error) => void) | undefined;
  onError?: ((error: Error) => void) | undefined;
  reconnectDelayMs?: number | undefined;
  maxEventBytes?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Envelope shape. Default: {@link OPENCODE_1_SSE_ENVELOPE}. */
  envelope?: OpenCodeSseEnvelope | undefined;
  /** Subscription path on the client's origin. Default: `/event`. */
  path?: string | undefined;
  /** Event types to subscribe to, each sent as one repeated `types` query parameter. Default: none (every type). */
  types?: readonly string[] | undefined;
  /**
   * Awaited before the record that revealed the gap is delivered, so the consumer can rehydrate first. Needs an
   * envelope with a `durableKey`. Duplicate or older seqs are delivered without a call.
   */
  onSequenceGap?: ((gap: OpenCodeSseSequenceGap) => void | Promise<void>) | undefined;
}

const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
/** Aggregates whose last seq is remembered; the oldest is forgotten first, which can only hide a gap, never invent one. */
const MAX_TRACKED_AGGREGATES = 4096;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDurable(value: unknown): OpenCodeSseDurable {
  if (
    !isObject(value) ||
    typeof value.aggregateID !== 'string' ||
    value.aggregateID.length === 0 ||
    typeof value.seq !== 'number' ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0 ||
    typeof value.version !== 'number' ||
    !Number.isFinite(value.version)
  ) {
    throw new Error('OpenCode SSE record durable stamp must be {aggregateID, seq, version}');
  }
  return { aggregateID: value.aggregateID, seq: value.seq, version: value.version };
}

/** With the 1.x envelope this is exactly the verified 1.x parse: the same checks, messages and record shape. */
export function parseOpenCodeSseRecord(
  data: string,
  envelope: OpenCodeSseEnvelope = OPENCODE_1_SSE_ENVELOPE,
): OpenCodeSseRecord {
  const parsed = JSON.parse(data) as unknown;
  if (!isObject(parsed)) throw new Error('OpenCode SSE data must be an object');
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error('OpenCode SSE record has no non-empty id');
  }
  if (typeof parsed.type !== 'string' || parsed.type.length === 0) {
    throw new Error('OpenCode SSE record has no non-empty type');
  }
  let payload = parsed[envelope.payloadKey];
  if (envelope.encodedPayload && typeof payload === 'string') payload = JSON.parse(payload) as unknown;
  if (!isObject(payload)) throw new Error(`OpenCode SSE record ${envelope.payloadKey} must be an object`);
  const durable =
    envelope.durableKey !== undefined && parsed[envelope.durableKey] !== undefined
      ? parseDurable(parsed[envelope.durableKey])
      : undefined;
  return { id: parsed.id, type: parsed.type, properties: payload, ...(durable ? { durable } : {}) };
}

/** Incremental decoder for SSE blocks; `data:` lines are joined per the SSE specification. */
export class OpenCodeSseDecoder {
  private buffer = '';

  constructor(private readonly maxEventBytes = DEFAULT_MAX_EVENT_BYTES) {}

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match || match.index === undefined) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (Buffer.byteLength(block, 'utf8') > this.maxEventBytes) {
        throw new Error(`OpenCode SSE event exceeded ${this.maxEventBytes} bytes`);
      }
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => (line.startsWith('data: ') ? line.slice(6) : line.slice(5)))
        .join('\n');
      if (data.length > 0) events.push(data);
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxEventBytes) {
      throw new Error(`OpenCode SSE event exceeded ${this.maxEventBytes} bytes`);
    }
    return events;
  }

  end(): string[] {
    if (this.buffer.trim().length === 0) {
      this.buffer = '';
      return [];
    }
    return this.feed('\n\n');
  }
}

export class OpenCodeEventStream {
  private readonly fetchImpl: typeof fetch;
  private readonly reconnectDelayMs: number;
  private readonly maxEventBytes: number;
  private controller: AbortController | undefined;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private loop: Promise<void> | undefined;
  private stopped = false;
  private opened = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private wakeReconnect: (() => void) | undefined;
  private readonly envelope: OpenCodeSseEnvelope;
  /** Last seq per aggregate, across reconnects: a gap that spans one is the signal that matters most. */
  private readonly lastSeq = new Map<string, number>();
  /** Aggregates seen since the current connection opened. */
  private readonly seenThisConnection = new Set<string>();

  constructor(private readonly options: OpenCodeEventStreamOptions) {
    this.fetchImpl = options.fetchImpl ?? loopbackFetch;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 100;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.envelope = options.envelope ?? OPENCODE_1_SSE_ENVELOPE;
    if (options.onSequenceGap && this.envelope.durableKey === undefined) {
      throw new Error('OpenCode SSE sequence gaps need an envelope with a durable key');
    }
  }

  start(): Promise<void> {
    if (this.loop) return this.waitUntilOpen();
    this.stopped = false;
    this.loop = this.run();
    return this.waitUntilOpen();
  }

  private firstOpenPromise: Promise<void> | undefined;
  private resolveFirstOpen: (() => void) | undefined;
  private rejectFirstOpen: ((error: Error) => void) | undefined;

  private waitUntilOpen(): Promise<void> {
    if (this.opened) return Promise.resolve();
    if (!this.firstOpenPromise) {
      this.firstOpenPromise = new Promise<void>((resolve, reject) => {
        this.resolveFirstOpen = resolve;
        this.rejectFirstOpen = reject;
      });
    }
    return this.firstOpenPromise;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const url = this.options.client.eventUrl({ path: this.options.path, types: this.options.types });
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: this.options.client.headers({ accept: 'text/event-stream' }),
          signal: this.controller.signal,
        });
        if (!response.ok) {
          throw new Error(`OpenCode SSE subscription failed with status ${response.status}`);
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().startsWith('text/event-stream')) {
          throw new Error(`OpenCode SSE subscription returned ${contentType || 'no content type'}`);
        }
        if (!response.body) throw new Error('OpenCode SSE subscription returned no body');

        const reconnect = this.opened;
        this.seenThisConnection.clear();
        await this.options.onOpen?.({ reconnect });
        if (!this.opened) {
          this.opened = true;
          this.resolveFirstOpen?.();
          this.resolveFirstOpen = undefined;
          this.rejectFirstOpen = undefined;
        }

        const reader = response.body.getReader();
        this.reader = reader;
        const text = new TextDecoder();
        const decoder = new OpenCodeSseDecoder(this.maxEventBytes);
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            for (const data of decoder.feed(text.decode(next.value, { stream: true }))) {
              await this.deliver(data);
            }
          }
          for (const data of decoder.feed(text.decode())) await this.deliver(data);
          for (const data of decoder.end()) await this.deliver(data);
        } finally {
          if (this.reader === reader) this.reader = undefined;
          reader.releaseLock();
        }
        if (!this.stopped) throw new Error('OpenCode SSE stream ended');
      } catch (error) {
        if (this.stopped) break;
        const failure = asError(error);
        if (!this.opened) {
          this.rejectFirstOpen?.(failure);
          this.resolveFirstOpen = undefined;
          this.rejectFirstOpen = undefined;
          this.stopped = true;
          break;
        }
        this.options.onError?.(failure);
        await this.waitToReconnect();
      } finally {
        this.controller = undefined;
      }
    }
  }

  private async deliver(data: string): Promise<void> {
    let record: OpenCodeSseRecord;
    try {
      record = parseOpenCodeSseRecord(data, this.envelope);
    } catch (error) {
      this.options.onMalformed?.(data, asError(error));
      return;
    }
    if (record.durable && this.options.onSequenceGap) await this.checkSequence(record, record.durable);
    await this.options.onRecord(record);
  }

  private async checkSequence(record: OpenCodeSseRecord, durable: OpenCodeSseDurable): Promise<void> {
    const { aggregateID, seq } = durable;
    const last = this.lastSeq.get(aggregateID);
    const acrossReconnect = !this.seenThisConnection.has(aggregateID);
    this.seenThisConnection.add(aggregateID);
    // A duplicate or an older seq says nothing about loss and must not move the mark back.
    if (last !== undefined && seq <= last) return;
    // The first seq an aggregate shows this stream is its starting point, not a gap: history before the
    // subscription was never this stream's to deliver.
    if (last !== undefined && seq !== last + 1) {
      // The mark moves only once the hook has handled the gap. A hook that fails (a rehydrate that could not reach
      // the server) leaves it where it was, so the stream's reconnect reports the gap again instead of losing it.
      await this.options.onSequenceGap?.({ aggregateID, expected: last + 1, received: seq, acrossReconnect, record });
    }
    this.lastSeq.delete(aggregateID);
    this.lastSeq.set(aggregateID, seq);
    if (this.lastSeq.size > MAX_TRACKED_AGGREGATES) {
      const oldest = this.lastSeq.keys().next().value;
      if (oldest !== undefined) this.lastSeq.delete(oldest);
    }
  }

  private waitToReconnect(): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.wakeReconnect = undefined;
        resolve();
      };
      this.wakeReconnect = finish;
      this.reconnectTimer = setTimeout(finish, this.reconnectDelayMs);
      this.reconnectTimer.unref();
    });
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.loop) return;
    this.stopped = true;
    this.controller?.abort();
    await this.reader?.cancel().catch(() => undefined);
    this.wakeReconnect?.();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }
}
