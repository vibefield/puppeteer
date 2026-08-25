import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERMES_HOME_ENV, HERMES_PYTHON_ENV } from '../generated/detection.js';

export interface HermesGatewayHost {
  url: string;
  pid: number | undefined;
  close(): Promise<void>;
}

export interface StartHermesGatewayHostOptions {
  python?: string;
  hermesHome: string;
  cwd: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
}

function hostScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../scripts/tui-gateway-host.py');
}

export function resolveHermesPython(explicit?: string): string {
  return explicit ?? process.env[HERMES_PYTHON_ENV] ?? 'python3';
}

export async function startHermesGatewayHost(options: StartHermesGatewayHostOptions): Promise<HermesGatewayHost> {
  const python = resolveHermesPython(options.python);
  const child: ChildProcess = spawn(python, [hostScript()], {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH,
      [HERMES_HOME_ENV]: options.hermesHome,
      HOME: options.hermesHome,
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const timeoutMs = options.startupTimeoutMs ?? 20_000;
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hermes gateway host did not publish a WebSocket URL')), timeoutMs);
    const fail = (error: Error): void => {
      clearTimeout(timer);
      reject(error);
    };
    child.once('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
    child.once('exit', (code, signal) => fail(new Error(`Hermes gateway host exited (${code ?? signal})`)));
    const stdout = child.stdout;
    if (!stdout) {
      fail(new Error('Hermes gateway host has no stdout'));
      return;
    }
    const rl = createInterface({ input: stdout });
    rl.once('line', (line) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(line) as { url?: string; error?: string };
        if (parsed.error) throw new Error(parsed.error);
        if (!parsed.url) throw new Error(`gateway host printed no url: ${line}`);
        resolve(parsed.url);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  return {
    url,
    pid: child.pid,
    async close() {
      if (child.exitCode !== null || child.signalCode) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolveClose) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolveClose();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolveClose();
        });
      });
    },
  };
}
