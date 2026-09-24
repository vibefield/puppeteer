/**
 * A small JSON-RPC 2.0 client for the Copilot CLI's server mode
 * (`copilot --server --stdio`), the process the official SDK starts and speaks
 * to over stdio. Only the requests the profile identity read makes go through
 * it, and nothing here opens a session.
 *
 * The transport is injected: the default spawns the server with exactly the
 * environment it is given; tests drive a scripted in-memory transport.
 */

import { spawn } from 'node:child_process';
import { FrameDecoder, encodeFrame } from './framing.js';

/**
 * How the SDK starts the CLI as a JSON-RPC server (not in `copilot --help`;
 * confirmed on 1.0.88). `--no-auto-update` keeps a read from updating the install.
 */
export const COPILOT_SERVER_ARGS: readonly string[] = ['--server', '--stdio', '--no-auto-update'];

export interface CopilotServerTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: () => void): void;
  /** Resolve once the server has stopped. Never rejects. */
  close(): Promise<void>;
}

export interface CopilotServerClientOptions {
  /** Upper bound for every request, the first of which also waits out the CLI's start. Default: 10 seconds. */
  requestTimeoutMs?: number;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export class CopilotServerClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  private closing?: Promise<void>;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly transport: CopilotServerTransport,
    options: CopilotServerClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    transport.onMessage((message) => this.receive(message));
    transport.onClose(() => {
      this.closed = true;
      this.rejectPending(new Error('the Copilot server closed'));
    });
  }

  /** Resolve with `result`; reject on a JSON-RPC error, a timeout, or a closed server. */
  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('the Copilot server client is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`\`${method}\` timed out after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.rejectPending(new Error('the Copilot server client is closed'));
      await this.transport.close();
    })();
    return this.closing;
  }

  private rejectPending(error: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  private receive(message: unknown): void {
    if (this.closed) return;
    const frame = rec(message);
    if (!frame || frame.id === undefined || frame.id === null) return; // notifications are not read
    if (typeof frame.method === 'string') {
      // A request from the server. Nothing this client starts asks it anything,
      // so it gets JSON-RPC "method not found" rather than a caller left waiting.
      this.transport.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'method not found' } });
      return;
    }
    const entry = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
    if (!entry) return;
    this.pending.delete(frame.id as number);
    clearTimeout(entry.timer);
    // The server's error text is not carried: only the code says what failed.
    const code = rec(frame.error)?.code;
    if (frame.error !== undefined) entry.reject(new Error(`the Copilot server answered with error ${String(code)}`));
    else entry.resolve(frame.result);
  }
}

/** A script executable (the Imposter's `ai.mjs`) runs under Node rather than being exec'd. */
const SCRIPT_EXECUTABLE = /\.(mjs|cjs|js|ts)$/u;
const STOP_GRACE_MS = 2_000;

export interface SpawnCopilotServerOptions {
  executable: string;
  /**
   * The server's whole environment. Nothing of this process's own is merged
   * in, so a variable the host happens to hold never reaches the server.
   */
  env: Record<string, string>;
  /** Wait for the server to exit after SIGTERM, and again after SIGKILL. Default: 2 seconds. */
  stopGraceMs?: number;
}

/** Default transport: spawn the server and speak Content-Length JSON-RPC over its stdio. */
export function spawnCopilotServerTransport(options: SpawnCopilotServerOptions): CopilotServerTransport {
  const script = SCRIPT_EXECUTABLE.test(options.executable);
  const command = script ? (process.versions.electron ? 'node' : process.execPath) : options.executable;
  const child = spawn(command, [...(script ? [options.executable] : []), ...COPILOT_SERVER_ARGS], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    // A session of its own: no controlling terminal to prompt on, and one
    // process group to stop, so a launcher's child or a `gh` it ran goes too.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const grace = options.stopGraceMs ?? STOP_GRACE_MS;
  const decoder = new FrameDecoder();
  let onMessage: ((message: unknown) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closed = false;
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  const markExited = (): void => {
    exited = true;
    resolveExit();
  };
  const markClosed = (): void => {
    markExited();
    if (closed) return;
    closed = true;
    onClose?.();
  };
  // The group is addressed only while its leader is unreaped: after that its
  // id can belong to an unrelated process group.
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (exited || child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // Every member has exited.
    }
  };
  const exitedWithin = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([exit.then(() => true as const), timedOut]);
    clearTimeout(timer);
    return result;
  };

  let corrupt = false;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (corrupt) return;
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      // Output that is not framed JSON-RPC is not this server; stop it.
      corrupt = true;
      signalGroup('SIGKILL');
      return;
    }
    for (const message of messages) onMessage?.(message);
  });
  // A write after the server has gone fails with EPIPE; the close reports that.
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('error', () => undefined);
  child.once('exit', markExited);
  child.once('close', markClosed);
  child.once('error', markClosed);

  return {
    send: (message) => {
      if (child.stdin?.writable) child.stdin.write(encodeFrame(message));
    },
    onMessage: (handler) => {
      onMessage = handler;
    },
    onClose: (handler) => {
      onClose = handler;
      if (closed) handler();
    },
    close: async () => {
      signalGroup('SIGTERM');
      if (await exitedWithin(grace)) return;
      signalGroup('SIGKILL');
      await exitedWithin(grace);
    },
  };
}
