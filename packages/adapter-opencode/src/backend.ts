/** Private OpenCode `serve` lifecycle and environment-only Basic auth. */

import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { OPENCODE_LAUNCH_FLAGS, resolveOpenCodeExecutable } from './detection.js';

export interface StartOpenCodeBackendOptions {
  executable?: string;
  env?: Record<string, string>;
  hostname?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface OpenCodeBackend {
  readonly origin: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly pid: number | undefined;
  running(): boolean;
  dispose(): Promise<void>;
}

const READY_PREFIX = 'opencode server listening on ';
const MAX_STARTUP_OUTPUT = 256 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function readinessOrigin(line: string, requestedHostname: string): string | undefined {
  if (!line.startsWith(READY_PREFIX)) return undefined;
  const candidate = line.slice(READY_PREFIX.length).trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  if (requestedHostname !== 'localhost' && url.hostname !== requestedHostname) return undefined;
  if (!url.port || url.pathname !== '/') return undefined;
  return url.origin;
}

async function terminateChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs);
    timeout.unref();
  });
  if ((await Promise.race([exited.then(() => 'exit' as const), timedOut])) === 'timeout') {
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
    await exited;
  }
  if (timeout) clearTimeout(timeout);
}

/**
 * Start one adapter-owned backend. The generated password exists only in this
 * process, the child environment, and the caller-owned TUI launch recipe.
 */
export async function startOpenCodeBackend(options: StartOpenCodeBackendOptions = {}): Promise<OpenCodeBackend> {
  const executable = resolveOpenCodeExecutable(options.executable);
  const hostname = options.hostname ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`OpenCode backend must bind loopback, got ${hostname}`);
  }
  const username = 'opencode';
  const password = randomBytes(32).toString('base64url');
  const child = spawn(
    executable,
    [
      OPENCODE_LAUNCH_FLAGS.serve,
      OPENCODE_LAUNCH_FLAGS.hostname,
      hostname,
      OPENCODE_LAUNCH_FLAGS.port,
      '0',
      OPENCODE_LAUNCH_FLAGS.pure,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...options.env,
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
      },
    },
  );

  let startupOutput = '';
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;

  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, readyOrigin?: string): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        child.stdout?.off('data', inspect);
        child.stdout?.resume();
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve(readyOrigin!);
      };
      const inspect = (chunk: Buffer | string): void => {
        startupOutput += chunk.toString();
        if (startupOutput.length > MAX_STARTUP_OUTPUT) {
          finish(new Error('OpenCode backend exceeded the bounded startup output limit'));
          return;
        }
        const lines = startupOutput.split(/\r?\n/);
        startupOutput = lines.pop() ?? '';
        for (const line of lines) {
          const readyOrigin = readinessOrigin(line.trim(), hostname);
          if (readyOrigin) {
            finish(undefined, readyOrigin);
            return;
          }
        }
      };
      const onError = (error: Error): void => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        const detail = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`;
        finish(new Error(`OpenCode backend stopped before readiness (${detail})`));
      };

      child.stdout?.on('data', inspect);
      // Drain stderr without logging it: startup diagnostics can contain paths,
      // while credentials must never enter a log or error string.
      child.stderr?.resume();
      child.once('error', onError);
      child.once('exit', onExit);
      timeout = setTimeout(
        () => finish(new Error(`OpenCode backend did not become ready within ${startupTimeoutMs}ms`)),
        startupTimeoutMs,
      );
      timeout.unref();
    });

    let disposed = false;
    return {
      origin,
      hostname,
      username,
      password,
      pid: child.pid,
      running: () => !disposed && child.exitCode === null && child.signalCode === null,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await terminateChild(child, options.shutdownTimeoutMs ?? 2_000);
      },
    };
  } catch (error) {
    await terminateChild(child, options.shutdownTimeoutMs ?? 2_000);
    throw error;
  }
}
