import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { HermesGatewayFrame, HermesGatewayRailStatus, HermesGatewayTransport } from './jsonrpc.js';

export class HermesStdioClient implements HermesGatewayTransport {
  private readonly listeners = new Set<(frame: HermesGatewayFrame) => void>();
  private readonly statusListeners = new Set<(status: HermesGatewayRailStatus) => void>();
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private railState: HermesGatewayRailStatus = { state: 'connected' };

  readonly stderr: string[] = [];

  constructor(private readonly child: ChildProcess) {
    if (!child.stdout || !child.stdin) throw new Error('Hermes stdio gateway needs piped stdin/stdout');
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
      this.pending.set(id, { resolve, reject });
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
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
    this.rejectPending('Hermes stdio gateway closed');
    this.listeners.clear();
    this.statusListeners.clear();
    this.child.stdin?.end();
    this.child.kill('SIGTERM');
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
      pending.reject(new Error(reason));
    }
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
