/** In-memory tui_gateway used by adapter tests. Not vendor evidence. */

import {
  eventType,
  type HermesGatewayFrame,
  type HermesGatewayRailStatus,
  type HermesGatewayTransport,
} from '../transport/jsonrpc.js';

export interface FakeHermesGatewayOptions {
  reply?: string;
  /** When false, session.create/resume omit session.info so the driver must acknowledge from the RPC result. */
  announceSession?: boolean;
}

export class FakeHermesGateway implements HermesGatewayTransport {
  readonly frames: HermesGatewayFrame[] = [];
  private readonly listeners = new Set<(frame: HermesGatewayFrame) => void>();
  private readonly statusListeners = new Set<(status: HermesGatewayRailStatus) => void>();
  private nextLive = 1;
  private storedId = '20260812_000000_c0ffee';
  private liveId = 'abcd1234';
  private messages: Array<{ role: string; text: string }> = [];
  private inputTokens = 0;
  private outputTokens = 0;
  private calls = 0;
  private connected = true;
  closed = false;
  readonly reply: string;

  private readonly announceSession: boolean;

  constructor(options: FakeHermesGatewayOptions = {}) {
    this.reply = options.reply ?? 'SURFACE_HERMES_OK';
    this.announceSession = options.announceSession !== false;
  }

  private sessionInfo(running: boolean): Record<string, unknown> {
    const total = this.inputTokens + this.outputTokens;
    return {
      model: 'puppeteer-hermes-census',
      provider: 'custom',
      reasoning_effort: 'medium',
      approval_mode: 'manual',
      yolo: false,
      stored_session_id: this.storedId,
      cwd: '/workspace',
      running,
      usage: {
        input: this.inputTokens,
        output: this.outputTokens,
        reasoning: 0,
        prompt: this.inputTokens,
        completion: this.outputTokens,
        total,
        calls: this.calls,
        compressions: 0,
        ...(this.calls > 0
          ? { context_used: total, context_max: 120_000, context_percent: (total / 120_000) * 100 }
          : {}),
      },
    };
  }

  emit(type: string, payload: Record<string, unknown> = {}, sessionId = this.liveId): void {
    if (!this.connected || this.closed) return;
    const frame: HermesGatewayFrame = {
      jsonrpc: '2.0',
      method: 'event',
      params: { type, session_id: sessionId, payload },
    };
    this.frames.push(frame);
    for (const listener of this.listeners) listener(frame);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed || !this.connected) throw new Error('fake gateway closed');
    if (method === 'session.create') {
      this.liveId = `live${this.nextLive++}`;
      this.storedId = `20260812_000000_${this.liveId.slice(-6)}`;
      this.messages = [];
      this.inputTokens = 0;
      this.outputTokens = 0;
      this.calls = 0;
      if (this.announceSession) {
        queueMicrotask(() => {
          this.emit('session.info', { ...this.sessionInfo(false), cwd: String(params.cwd ?? '/workspace') });
        });
      }
      return { session_id: this.liveId, stored_session_id: this.storedId, message_count: 0 };
    }
    if (method === 'session.resume') {
      this.liveId = `live${this.nextLive++}`;
      this.storedId = String(params.session_id ?? this.storedId);
      if (this.announceSession) {
        queueMicrotask(() => {
          this.emit('session.info', this.sessionInfo(false));
        });
      }
      return {
        session_id: this.liveId,
        resumed: this.storedId,
        session_key: this.storedId,
        status: 'idle',
        message_count: this.messages.length,
        messages: this.messages,
        running: false,
      };
    }
    if (method === 'prompt.submit') {
      const text = String(params.text ?? '');
      this.messages.push({ role: 'user', text });
      this.messages.push({ role: 'assistant', text: this.reply });
      this.inputTokens += 24;
      this.outputTokens += 6;
      this.calls += 1;
      queueMicrotask(() => {
        this.emit('message.start');
        this.emit('message.delta', { text: this.reply });
        this.emit('message.complete', { text: this.reply, status: 'complete', usage: this.sessionInfo(false).usage });
        this.emit('session.info', this.sessionInfo(false));
      });
      return { status: 'streaming' };
    }
    if (method === 'session.interrupt') return { status: 'interrupted' };
    throw new Error(`fake gateway does not serve ${method}`);
  }

  onFrame(listener: (frame: HermesGatewayFrame) => void): () => void {
    this.listeners.add(listener);
    const ready = this.frames.find((frame) => eventType(frame) === 'gateway.ready');
    if (ready) queueMicrotask(() => listener(ready));
    else queueMicrotask(() => this.emit('gateway.ready', {}, ''));
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: HermesGatewayRailStatus) => void): () => void {
    this.statusListeners.add(listener);
    queueMicrotask(() => {
      if (!this.statusListeners.has(listener)) return;
      listener(this.connected && !this.closed ? { state: 'connected' } : { state: 'disconnected' });
    });
    return () => this.statusListeners.delete(listener);
  }

  disconnect(reason = 'fake gateway observation disconnected'): void {
    if (!this.connected || this.closed) return;
    this.connected = false;
    for (const listener of this.statusListeners) listener({ state: 'disconnected', reason });
  }

  reconnect(): void {
    if (this.connected || this.closed) return;
    this.connected = true;
    for (const listener of this.statusListeners) listener({ state: 'connected' });
  }

  async close(): Promise<void> {
    this.disconnect('fake gateway closed');
    this.closed = true;
    this.listeners.clear();
    this.statusListeners.clear();
  }

  waitFor(type: string, timeoutMs = 1_000): Promise<HermesGatewayFrame> {
    const existing = this.frames.find((frame) => eventType(frame) === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const off = this.onFrame((frame) => {
        if (eventType(frame) === type) {
          off();
          resolve(frame);
        }
      });
      setTimeout(() => {
        off();
        reject(new Error(`fake gateway wait timed out: ${type}`));
      }, timeoutMs);
    });
  }
}

export { eventType };
