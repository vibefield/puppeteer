/** JSON-RPC client for a Puppeteer-owned Hermes tui_gateway WebSocket. */

import { authorizedGatewayUrl } from './gateway-auth.js';

export interface HermesGatewayFrame {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
  direction?: string;
}

export type HermesGatewayRailStatus = { state: 'connected' } | { state: 'disconnected'; reason?: string };

export interface HermesGatewayTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onFrame(listener: (frame: HermesGatewayFrame) => void): () => void;
  /** Optional health rail; disconnect never implies that the attached native TUI exited. */
  onStatus?(listener: (status: HermesGatewayRailStatus) => void): () => void;
  close(): Promise<void>;
}

export function eventType(frame: HermesGatewayFrame): string | undefined {
  return frame.method === 'event' ? String(frame.params?.type ?? '') || undefined : undefined;
}

export interface HermesJsonRpcClientOptions {
  /** The gateway's bearer (`gateway-auth.ts`); absent only for a gateway that admits anyone. */
  token?: string | undefined;
}

export class HermesJsonRpcClient implements HermesGatewayTransport {
  private readonly listeners = new Set<(frame: HermesGatewayFrame) => void>();
  private readonly statusListeners = new Set<(status: HermesGatewayRailStatus) => void>();
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private socket: WebSocket | undefined;
  private railState: HermesGatewayRailStatus = { state: 'disconnected', reason: 'not connected' };

  /** `url` is the bare gateway URL, which errors name; the token rides only the handshake. */
  constructor(
    private readonly url: string,
    private readonly options: HermesJsonRpcClientOptions = {},
  ) {}

  async connect(timeoutMs = 10_000): Promise<void> {
    if (this.socket) return;
    const socket = new WebSocket(authorizedGatewayUrl(this.url, this.options.token));
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      for (const line of text.split('\n').filter(Boolean)) {
        let frame: HermesGatewayFrame;
        try {
          frame = JSON.parse(line) as HermesGatewayFrame;
        } catch {
          continue;
        }
        this.dispatch(frame);
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.disconnect('Hermes gateway WebSocket closed');
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Hermes gateway connect timed out: ${this.url}`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        this.setRailStatus({ state: 'connected' });
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        this.disconnect('Hermes gateway WebSocket error');
        reject(new Error(`Hermes gateway connect failed: ${this.url}`));
      });
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Hermes gateway is not connected (${method})`));
    }
    const id = String(this.nextId++);
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.send(`${JSON.stringify(payload)}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Hermes RPC timed out: ${method}`));
        }
      }, 45_000);
    });
  }

  onFrame(listener: (frame: HermesGatewayFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: HermesGatewayRailStatus) => void): () => void {
    this.statusListeners.add(listener);
    queueMicrotask(() => {
      if (this.statusListeners.has(listener)) listener(this.railState);
    });
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.rejectPending('Hermes gateway closed');
    this.listeners.clear();
    this.statusListeners.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.close();
  }

  private disconnect(reason: string): void {
    this.rejectPending(reason);
    this.setRailStatus({ state: 'disconnected', reason });
  }

  private rejectPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }

  private setRailStatus(status: HermesGatewayRailStatus): void {
    if (this.railState.state === status.state) return;
    this.railState = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private dispatch(frame: HermesGatewayFrame): void {
    if (frame.id != null && this.pending.has(String(frame.id))) {
      const pending = this.pending.get(String(frame.id));
      this.pending.delete(String(frame.id));
      if (frame.error) pending?.reject(new Error(frame.error.message ?? JSON.stringify(frame.error)));
      else pending?.resolve(frame.result);
    }
    for (const listener of this.listeners) listener(frame);
  }
}
