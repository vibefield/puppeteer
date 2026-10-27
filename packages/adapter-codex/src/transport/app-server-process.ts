/** Process ownership and platform endpoint selection for a private Codex app-server. */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexExecutable } from '../detection.js';
import type { AppServerEndpoint } from './ws-transport.js';

let serverCounter = 0;

/**
 * On Windows kill() ends only the named process. The app-server starts helpers of its own (its
 * curated-plugin sync runs git under CODEX_HOME) that would outlive it and keep that home locked, so
 * end the whole tree while the parent still anchors it. The exit event stays the source of truth.
 */
function terminateWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

export type AppServerTransportKind = 'unix' | 'websocket';

export function defaultAppServerTransportKind(platform: NodeJS.Platform = process.platform): AppServerTransportKind {
  return platform === 'win32' ? 'websocket' : 'unix';
}

export interface AppServerHandle {
  process: ChildProcess;
  /** Available after `ready()`; consumers never need platform-specific addressing. */
  endpoint(): AppServerEndpoint;
  /** Resolves once the UDS exists or the ephemeral loopback address is reported. */
  ready(timeoutMs?: number): Promise<void>;
  /** Stop the app-server and resolve only after its process releases session state. */
  dispose(): Promise<void>;
}

export interface SpawnAppServerOptions {
  executable?: string;
  /** Defaults to UDS on POSIX and ephemeral loopback WebSocket on Windows. */
  transport?: AppServerTransportKind;
  /** Optional explicit UDS path; valid only with the Unix transport. */
  socketPath?: string;
  /**
   * Extra environment for the app-server child, merged over this process's own.
   *
   * This child is private to the recipe — a caller has no other way to reach
   * it, since it is not the terminal and carries no launch spec. That matters
   * for anything the binary reads from the environment rather than argv, which
   * is how the puppeteer imposter is told which vendor to be (docs/archive/IMPOSTER.md §6).
   */
  env?: Record<string, string>;
  /** False when `env` is already the child's complete environment (a host's helper environment). */
  inheritEnvironment?: boolean;
  /**
   * Arguments for `codex app-server` itself, ahead of `--listen` — the settings a
   * typed invocation carries to the thread's server (`-c`, `--enable`, `--disable`).
   * The server is private to one session, so its settings are that session's.
   */
  args?: readonly string[];
}

/**
 * Spawn one private Codex app-server. POSIX prefers a fresh UDS under the REAL
 * temp dir (macOS `/tmp` is a symlink the app-server's lstat rejects); Windows
 * binds an ephemeral IPv4 loopback WebSocket and discovers its actual port from
 * the app-server's startup banner.
 */
export function spawnAppServer(opts: SpawnAppServerOptions = {}): AppServerHandle {
  const transportKind = opts.transport ?? defaultAppServerTransportKind();
  if (transportKind === 'websocket' && opts.socketPath) {
    throw new Error('socketPath is valid only for the Codex Unix app-server transport');
  }
  const socketPath =
    transportKind === 'unix'
      ? (opts.socketPath ?? join(realpathSync(tmpdir()), `puppeteer-codex-${process.pid}-${serverCounter++}.sock`))
      : undefined;
  if (socketPath) rmSync(socketPath, { force: true });
  const requestedAddress = socketPath ? `unix://${socketPath}` : 'ws://127.0.0.1:0';
  const child = spawn(
    resolveCodexExecutable(opts.executable),
    ['app-server', ...(opts.args ?? []), '--listen', requestedAddress],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(opts.inheritEnvironment === false
        ? { env: { ...opts.env } }
        : opts.env
          ? { env: { ...process.env, ...opts.env } }
          : {}),
    },
  );
  let resolvedEndpoint: AppServerEndpoint | undefined;
  let stderr = '';
  let readySettled = false;
  let readyPoll: NodeJS.Timeout | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void readyPromise.catch(() => undefined);
  let processSettled = false;
  let resolveProcessExit!: () => void;
  const processExit = new Promise<void>((resolve) => {
    resolveProcessExit = resolve;
  });
  let disposal: Promise<void> | undefined;

  const readinessError = (message: string): Error => {
    const diagnostics = stderr.trim();
    return new Error(diagnostics ? `${message}\n${diagnostics}` : message);
  };
  const settleReady = (endpoint: AppServerEndpoint): void => {
    if (readySettled) return;
    readySettled = true;
    if (readyPoll) clearTimeout(readyPoll);
    resolvedEndpoint = endpoint;
    resolveReady();
  };
  const failReady = (error: Error): void => {
    if (readySettled) return;
    readySettled = true;
    if (readyPoll) clearTimeout(readyPoll);
    rejectReady(error);
  };
  const settleProcess = (): void => {
    if (processSettled) return;
    processSettled = true;
    resolveProcessExit();
  };
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    // Native startup diagnostics arrive just after bind. Observe the socket
    // immediately on that wakeup instead of always paying the next 50 ms poll.
    // The filesystem check is still authoritative; polling remains the fallback
    // for versions that print nothing or print before creating their listener.
    if (!readySettled && socketPath && existsSync(socketPath)) settleReady({ kind: 'unix', path: socketPath });
    if (transportKind !== 'websocket') return;
    const match = /listening on:\s+(ws:\/\/(?:\[[^\]]+\]|[^:\s]+):\d+)/.exec(stderr);
    if (match?.[1]) settleReady({ kind: 'websocket', url: match[1] });
  });
  child.once('error', (error) => {
    failReady(readinessError(`failed to start Codex app-server: ${error.message}`));
    settleProcess();
  });
  child.once('exit', (code, signal) => {
    failReady(readinessError(`Codex app-server exited before ready (code ${code}, signal ${signal ?? 'none'})`));
    settleProcess();
  });
  if (socketPath) {
    const poll = (): void => {
      if (readySettled) return;
      if (existsSync(socketPath)) {
        settleReady({ kind: 'unix', path: socketPath });
        return;
      }
      readyPoll = setTimeout(poll, 50);
      readyPoll.unref?.();
    };
    poll();
  }

  const hasExited = (): boolean => processSettled || child.exitCode !== null || child.signalCode !== null;
  const exitedWithin = async (timeoutMs: number): Promise<boolean> => {
    if (hasExited()) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([processExit.then(() => true as const), timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  };
  const cleanup = (): void => {
    if (readyPoll) clearTimeout(readyPoll);
    if (socketPath) rmSync(socketPath, { force: true });
  };

  return {
    process: child,
    endpoint() {
      if (!resolvedEndpoint) throw new Error('Codex app-server endpoint requested before ready');
      return resolvedEndpoint;
    },
    async ready(timeoutMs = 8_000) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new RangeError('app-server ready timeout must be positive');
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          readyPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(readinessError('Codex app-server endpoint not ready in time')), timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    dispose() {
      if (disposal) return disposal;
      disposal = (async () => {
        failReady(new Error('Codex app-server disposed before ready'));
        if (!hasExited()) {
          if (process.platform === 'win32' && child.pid !== undefined) {
            await terminateWindowsTree(child.pid);
          } else {
            try {
              child.kill('SIGTERM');
            } catch {
              // The exit/error event remains the source of truth.
            }
          }
        }
        if (!(await exitedWithin(2_000))) {
          try {
            child.kill('SIGKILL');
          } catch {
            // The final bounded wait below reports a surviving process.
          }
        }
        if (!(await exitedWithin(2_000))) {
          cleanup();
          throw new Error(`Codex app-server process ${child.pid ?? '?'} survived SIGTERM and SIGKILL`);
        }
        cleanup();
      })();
      return disposal;
    },
  };
}
