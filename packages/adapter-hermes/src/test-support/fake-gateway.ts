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
  /** Durable vendor state shared by distinct gateway process lifetimes. */
  state?: FakeHermesGatewayState;
}

export interface FakeHermesGatewayState {
  nextLive: number;
  storedId: string;
  messages: Array<{ role: string; text: string }>;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export function createFakeHermesGatewayState(): FakeHermesGatewayState {
  return {
    nextLive: 1,
    storedId: '20260812_000000_c0ffee',
    messages: [],
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
  };
}

export class FakeHermesGateway implements HermesGatewayTransport {
  readonly frames: HermesGatewayFrame[] = [];
  private readonly listeners = new Set<(frame: HermesGatewayFrame) => void>();
  private readonly statusListeners = new Set<(status: HermesGatewayRailStatus) => void>();
  private liveId = 'abcd1234';
  private connected = true;
  closed = false;
  readonly reply: string;

  private readonly announceSession: boolean;
  private readonly state: FakeHermesGatewayState;

  constructor(options: FakeHermesGatewayOptions = {}) {
    this.reply = options.reply ?? 'SURFACE_HERMES_OK';
    this.announceSession = options.announceSession !== false;
    this.state = options.state ?? createFakeHermesGatewayState();
  }

  private sessionInfo(running: boolean): Record<string, unknown> {
    const total = this.state.inputTokens + this.state.outputTokens;
    return {
      model: 'puppeteer-hermes-census',
      provider: 'custom',
      reasoning_effort: 'medium',
      approval_mode: 'manual',
      yolo: false,
      stored_session_id: this.state.storedId,
      cwd: '/workspace',
      running,
      usage: {
        input: this.state.inputTokens,
        output: this.state.outputTokens,
        reasoning: 0,
        prompt: this.state.inputTokens,
        completion: this.state.outputTokens,
        total,
        calls: this.state.calls,
        compressions: 0,
        ...(this.state.calls > 0
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
      this.liveId = `live${this.state.nextLive++}`;
      this.state.storedId = `20260812_000000_${this.liveId.slice(-6)}`;
      this.state.messages = [];
      this.state.inputTokens = 0;
      this.state.outputTokens = 0;
      this.state.calls = 0;
      if (this.announceSession) {
        queueMicrotask(() => {
          this.emit('session.info', { ...this.sessionInfo(false), cwd: String(params.cwd ?? '/workspace') });
        });
      }
      return { session_id: this.liveId, stored_session_id: this.state.storedId, message_count: 0 };
    }
    if (method === 'session.resume') {
      this.liveId = `live${this.state.nextLive++}`;
      this.state.storedId = String(params.session_id ?? this.state.storedId);
      if (this.announceSession) {
        queueMicrotask(() => {
          this.emit('session.info', this.sessionInfo(false));
        });
      }
      return {
        session_id: this.liveId,
        resumed: this.state.storedId,
        session_key: this.state.storedId,
        status: 'idle',
        message_count: this.state.messages.length,
        running: false,
      };
    }
    if (method === 'prompt.submit') {
      const text = String(params.text ?? '');
      this.state.messages.push({ role: 'user', text });
      this.state.messages.push({ role: 'assistant', text: this.reply });
      this.state.inputTokens += 24;
      this.state.outputTokens += 6;
      this.state.calls += 1;
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
