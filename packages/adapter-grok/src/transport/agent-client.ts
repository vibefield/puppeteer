/**
 * One `grok agent --no-leader stdio` process: ACP as newline-delimited JSON-RPC
 * over the child's stdin and stdout, for the provider-scoped reads (account
 * usage, profile identity) that need no TUI session. Each read owns one
 * short-lived process. A request the agent sends is refused with -32601: these
 * reads grant it no client capability.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { resolveGrokExecutable } from '../detection.js';

/**
 * Wire names of the xAI extension methods these reads call. ACP custom methods
 * require one leading `_`, which the agent strips before matching its `x.ai/…`
 * handler; the bare names return -32601.
 */
export const GROK_BILLING_ACP_METHOD = '_x.ai/billing';
export const GROK_AUTH_INFO_ACP_METHOD = '_x.ai/auth/info';

export const JSONRPC_METHOD_NOT_FOUND = -32_601;
const GROK_AGENT_ARGS = ['agent', '--no-leader', 'stdio'] as const;

export interface GrokAgentTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (info: { code: number | null; signal: string | null }) => void): void;
  close(): void | Promise<void>;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

export class GrokAcpError extends Error {
  constructor(public readonly body: JsonRpcErrorBody) {
    super(body.message);
    this.name = 'GrokAcpError';
  }
}

class GrokAcpRequestTimeoutError extends Error {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
  ) {
    super(`Grok ACP request "${method}" timed out after ${timeoutMs}ms`);
    this.name = 'GrokAcpRequestTimeoutError';
  }
}

export class GrokAcpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly transport: GrokAgentTransport,
    requestTimeoutMs: number,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    transport.onMessage((message) => this.handle(message));
    transport.onClose(() => {
      this.closed = true;
      this.rejectAllPending(new Error('Grok ACP transport closed'));
    });
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('client closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new GrokAcpRequestTimeoutError(method, this.requestTimeoutMs));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.rejectAllPending(new Error('client closed'));
    try {
      this.closePromise = Promise.resolve(this.transport.close());
    } catch (error) {
      this.closePromise = Promise.reject(error);
    }
    return this.closePromise;
  }

  private rejectAllPending(error: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  private handle(message: unknown): void {
    if (this.closed) return;
    const body = rec(message);
    if (!body) return;
    const hasId = body.id !== undefined && body.id !== null;
    const method = str(body.method);

    if (hasId && method === undefined) {
      const id = body.id as number;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (body.error !== undefined) entry.reject(new GrokAcpError(body.error as JsonRpcErrorBody));
      else entry.resolve(body.result);
      return;
    }

    if (hasId && method !== undefined) {
      this.transport.send({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: JSONRPC_METHOD_NOT_FOUND, message: 'Method not found' },
      });
    }
  }
}

/**
 * Spawn the agent. `env` is the child's whole environment, this process's when
 * absent: a caller that extends the parent's merges it before passing it.
 */
export function spawnGrokAgentTransport(
  options: { executable?: string; env?: NodeJS.ProcessEnv } = {},
): GrokAgentTransport {
  const child = spawn(resolveGrokExecutable(options.executable), [...GROK_AGENT_ARGS], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: tmpdir(),
    env: options.env ?? process.env,
    windowsHide: true,
  });
  child.stderr?.resume();
  const rl = createInterface({ input: child.stdout });
  let onMsg: ((message: unknown) => void) | undefined;
  let onCls: ((info: { code: number | null; signal: string | null }) => void) | undefined;
  let closedInfo: { code: number | null; signal: string | null } | undefined;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  const markClosed = (info: { code: number | null; signal: string | null }): void => {
    if (closedInfo) return;
    closedInfo = info;
    resolveExited();
    onCls?.(info);
  };

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onMsg?.(JSON.parse(trimmed) as unknown);
    } catch {
      // Non-JSON banner lines are ignored.
    }
  });
  child.on('exit', (code, signal) => markClosed({ code, signal }));
  child.on('error', () => markClosed({ code: null, signal: null }));

  const exitedWithin = async (timeoutMs: number): Promise<boolean> => {
    if (closedInfo) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([exited.then(() => true as const), timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  };

  return {
    send: (message) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (handler) => {
      onMsg = handler;
    },
    onClose: (handler) => {
      onCls = handler;
      if (closedInfo) handler(closedInfo);
    },
    close: async () => {
      if (closedInfo) return;
      try {
        child.kill('SIGTERM');
      } catch {
        if (child.exitCode !== null || child.signalCode !== null) return;
      }
      if (await exitedWithin(2_000)) return;
      try {
        child.kill('SIGKILL');
      } catch {
        if (child.exitCode !== null || child.signalCode !== null) return;
      }
      if (!(await exitedWithin(2_000))) {
        throw new Error(`grok agent process ${child.pid ?? '?'} survived SIGTERM and SIGKILL`);
      }
    },
  };
}
