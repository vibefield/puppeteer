import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERMES_HOME_ENV, HERMES_PYTHON_ENV } from '../generated/detection.js';
import { createHermesGatewayToken } from '../transport/gateway-auth.js';

export interface HermesGatewayHost {
  /** The bare WebSocket URL; a client presents `token` with it (`authorizedGatewayUrl`). */
  url: string;
  /** This launch's bearer. The host refuses every connection without it, and every browser Origin. */
  token: string;
  pid: number | undefined;
  close(): Promise<void>;
}

export interface StartHermesGatewayHostOptions {
  python?: string | undefined;
  hermesHome: string;
  cwd: string;
  env?: Record<string, string> | undefined;
  startupTimeoutMs?: number | undefined;
}

async function terminateChild(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  if ((await Promise.race([exited.then(() => 'exit' as const), timedOut])) === 'timeout') {
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
    await exited;
  }
  if (timer) clearTimeout(timer);
}

function hostScript(): string {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const packaged = join(moduleRoot, 'tui-gateway-host.py');
  return existsSync(packaged) ? packaged : join(moduleRoot, '../../scripts/tui-gateway-host.py');
}

export function resolveHermesPython(explicit?: string): string {
  return explicit ?? process.env[HERMES_PYTHON_ENV] ?? 'python3';
}

export async function startHermesGatewayHost(options: StartHermesGatewayHostOptions): Promise<HermesGatewayHost> {
  const python = resolveHermesPython(options.python);
  const token = createHermesGatewayToken();
  const child: ChildProcess = spawn(python, [hostScript()], {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH,
      [HERMES_HOME_ENV]: options.hermesHome,
      HOME: options.hermesHome,
      ...(options.env ?? {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // The bearer rides stdin, never argv or the environment: any same-user
  // process can read both with ps, and the host's environment reaches every
  // tool the agent runs. A write to a host that has already gone fails with
  // EPIPE; its exit reports that.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(`${token}\n`);

  // Importing the exact locked Hermes graph can take tens of seconds on a
  // cold machine even though gateway.ready is fast after import completes.
  const timeoutMs = options.startupTimeoutMs ?? 90_000;
  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rl?.close();
        child.off('error', fail);
        child.off('exit', exited);
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(
        () => finish(new Error('Hermes gateway host did not publish a WebSocket URL')),
        timeoutMs,
      );
      let rl: ReturnType<typeof createInterface> | undefined;
      const fail = (error: Error): void => finish(error);
      const exited = (code: number | null, signal: NodeJS.Signals | null): void =>
        finish(new Error(`Hermes gateway host exited (${code ?? signal})`));
      child.once('error', fail);
      child.once('exit', exited);
      const stdout = child.stdout;
      if (!stdout) {
        finish(new Error('Hermes gateway host has no stdout'));
        return;
      }
      // Diagnostics can contain local paths or provider configuration. Drain
      // them without reflecting their contents into an application error.
      child.stderr?.resume();
      rl = createInterface({ input: stdout });
      rl.once('line', (line) => {
        try {
          const parsed = JSON.parse(line) as { url?: string; error?: string };
          if (parsed.error) throw new Error('Hermes gateway host reported a startup error');
          if (!parsed.url) throw new Error('Hermes gateway host printed no URL');
          finish(undefined, parsed.url);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  } catch (error) {
    await terminateChild(child);
    throw error;
  }

  return {
    url,
    token,
    pid: child.pid,
    async close() {
      await terminateChild(child);
    },
  };
}
