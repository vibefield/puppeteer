/** Exact OpenCode SSE framing, reconnect, and bounded malformed-record handling. */

import type { OpenCodeClient } from './client.js';

export interface OpenCodeSseRecord {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface OpenCodeEventStreamOptions {
  client: OpenCodeClient;
  onOpen?: (context: { reconnect: boolean }) => void | Promise<void>;
  onRecord: (record: OpenCodeSseRecord) => void | Promise<void>;
  onMalformed?: (data: string, error: Error) => void;
  onError?: (error: Error) => void;
  reconnectDelayMs?: number | undefined;
  maxEventBytes?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parseRecord(data: string): OpenCodeSseRecord {
  const parsed = JSON.parse(data) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenCode SSE data must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error('OpenCode SSE record has no non-empty id');
  }
  if (typeof record.type !== 'string' || record.type.length === 0) {
    throw new Error('OpenCode SSE record has no non-empty type');
  }
  if (record.properties === null || typeof record.properties !== 'object' || Array.isArray(record.properties)) {
    throw new Error('OpenCode SSE record properties must be an object');
  }
  return {
    id: record.id,
    type: record.type,
    properties: record.properties as Record<string, unknown>,
  };
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

  constructor(private readonly options: OpenCodeEventStreamOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 100;
    this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
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
        const response = await this.fetchImpl(this.options.client.eventUrl(), {
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
      record = parseRecord(data);
    } catch (error) {
      this.options.onMalformed?.(data, asError(error));
      return;
    }
    await this.options.onRecord(record);
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
