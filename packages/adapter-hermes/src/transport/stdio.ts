import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { HermesGatewayFrame, HermesGatewayRailStatus, HermesGatewayTransport } from './jsonrpc.js';

export class HermesStdioClient implements HermesGatewayTransport {
  private readonly listeners = new Set<(frame: HermesGatewayFrame) => void>();
  private readonly statusListeners = new Set<(status: HermesGatewayRailStatus) => void>();
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly exitPromise: Promise<void>;
  private nextId = 1;
  private railState: HermesGatewayRailStatus = { state: 'connected' };
  private closing: Promise<void> | undefined;

  readonly stderr: string[] = [];

  constructor(private readonly child: ChildProcess) {
    if (!child.stdout || !child.stdin) throw new Error('Hermes stdio gateway needs piped stdin/stdout');
    this.exitPromise = new Promise((resolve) => {
      if (this.processExited()) resolve();
      else {
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderr.push(chunk);
    });
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let frame: HermesGatewayFrame;
      try {
        frame = JSON.parse(line) as HermesGatewayFrame;
      } catch {
        return;
      }
      if (frame.id != null && this.pending.has(String(frame.id))) {
        const pending = this.pending.get(String(frame.id));
        this.pending.delete(String(frame.id));
        if (pending) clearTimeout(pending.timer);
        if (frame.error) pending?.reject(new Error(frame.error.message ?? JSON.stringify(frame.error)));
        else pending?.resolve(frame.result);
      }
      for (const listener of this.listeners) listener(frame);
    });
    child.once('error', (error) => this.disconnect(`Hermes stdio gateway error: ${error.message}`));
    child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
      this.disconnect(`Hermes stdio gateway closed (${detail})`);
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const stdin = this.child.stdin;
    if (!stdin?.writable) return Promise.reject(new Error(`Hermes stdio gateway is closed (${method})`));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Hermes RPC timed out: ${method}`));
        }
      }, 45_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
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
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.rejectPending('Hermes stdio gateway closed');
      this.listeners.clear();
      this.statusListeners.clear();
      this.child.stdin?.end();
      if (!this.processExited()) this.child.kill('SIGTERM');
      await this.waitForExit(2_000);
      if (!this.processExited()) {
        this.child.kill('SIGKILL');
        await this.waitForExit(2_000);
      }
      if (!this.processExited()) {
        throw new Error(`Hermes stdio gateway process ${this.child.pid ?? '?'} survived SIGTERM and SIGKILL`);
      }
    })();
    return this.closing;
  }

  processExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  private disconnect(reason: string): void {
    this.rejectPending(reason);
    if (this.railState.state === 'disconnected') return;
    this.railState = { state: 'disconnected', reason };
    for (const listener of this.statusListeners) listener(this.railState);
  }

  private rejectPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.processExited()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

export function spawnHermesStdioGateway(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): HermesStdioClient {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env, PUPPETEER_IMPOSTER_TUI: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new HermesStdioClient(child);
}
