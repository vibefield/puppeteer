import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface GrokLeader {
  readonly startedAtMs: number;
  readonly socketPath: string;
  readonly readinessPath: string;
  readonly directory: string;
  readonly child: ChildProcess;
}

export interface GrokLeaderService {
  ensure(): Promise<string>;
  /** The live leader `ensure` answered with, for naming it to the host. Absent while none stands. */
  helper(): { pid: number | undefined; startedAtMs: number } | undefined;
  /** Resolves once every leader has exited (or was killed after the grace period) and its directory is gone. */
  dispose(): Promise<void>;
}

export interface CreateGrokLeaderServiceOptions {
  executable: string;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Grok keeps a path-shaped API on every platform, but Windows hashes that path
 * into a named pipe and therefore never creates `leader.sock`. Its adjacent
 * leader lock is the portable process-owned readiness signal; the following
 * ACP connection remains the authoritative protocol-readiness gate.
 */
export function grokLeaderReadinessPath(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && socketPath.endsWith('.sock') ? `${socketPath.slice(0, -5)}.lock` : socketPath;
}

/** A Unix socket path's limit on macOS, whose `sun_path` is the shorter of the two platforms': 104 bytes with its NUL. */
const GROK_LEADER_SOCKET_MAX_BYTES = 103;

/**
 * A leader binds PATH and, in Grok Build unified, a shared daemon at `PATH.daemon` beside it (`--leader-socket` help),
 * so both must fit. On Windows the path is only hashed into a named pipe's name.
 */
export function grokLeaderSocketFits(socketPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || Buffer.byteLength(`${socketPath}.daemon`) <= GROK_LEADER_SOCKET_MAX_BYTES;
}

/**
 * Grok 1.0.70 drains for about 2 s after SIGTERM (exit 143) and unlinks its own
 * socket; 1.0.0 exited within milliseconds. Removing the leader's directory, or
 * starting another leader on the same GROK_HOME, while it still drains would race
 * its final session writes, so shutdown waits for the exit and escalates to
 * SIGKILL only after this grace period.
 */
export const GROK_LEADER_EXIT_GRACE_MS = 3_000;

/** The part of a leader ChildProcess shutdown needs. */
interface LeaderProcess {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'exit', listener: () => void): unknown;
}

/** SIGTERM, wait for the exit (at most `graceMs`, then SIGKILL), then clean up. */
export function stopGrokLeaderProcess(
  child: LeaderProcess,
  cleanup: () => void,
  graceMs: number = GROK_LEADER_EXIT_GRACE_MS,
): Promise<void> {
  const signal = (name: NodeJS.Signals): void => {
    try {
      child.kill(name);
    } catch {
      // The leader has already exited.
    }
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    cleanup();
    return Promise.resolve();
  }
  // Windows can retain the lock file until the handle closes, so the exit
  // always gets another cleanup attempt, even after the grace period expired.
  child.once('exit', () => cleanup());
  signal('SIGTERM');
  if (child.pid === undefined) {
    // The process never started; no exit will follow.
    cleanup();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      signal('SIGKILL');
      finish();
    }, graceMs);
    timer.unref?.();
    child.once('exit', finish);
  });
}

export function createGrokLeaderService(options: CreateGrokLeaderServiceOptions): GrokLeaderService {
  let leader: GrokLeader | undefined;
  let startingLeader: GrokLeader | undefined;
  let leaderPromise: Promise<GrokLeader> | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const stopping = new WeakMap<GrokLeader, Promise<void>>();

  const live = (candidate: GrokLeader | undefined): candidate is GrokLeader =>
    candidate !== undefined &&
    candidate.child.exitCode === null &&
    candidate.child.signalCode === null &&
    !candidate.child.killed;

  const cleanDirectory = (candidate: GrokLeader): void => {
    try {
      rmSync(candidate.directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    } catch {
      // Windows can retain the lock file until process exit; the registered
      // exit callback gets another cleanup attempt after the handle closes.
    }
  };

  const stop = (candidate: GrokLeader | undefined): Promise<void> => {
    if (!candidate) return Promise.resolve();
    if (leader === candidate) leader = undefined;
    if (startingLeader === candidate) startingLeader = undefined;
    // A second SIGTERM could cut a draining leader's shutdown short.
    let stopped = stopping.get(candidate);
    if (!stopped) {
      stopped = stopGrokLeaderProcess(candidate.child, () => cleanDirectory(candidate));
      stopping.set(candidate, stopped);
    }
    return stopped;
  };

  async function start(): Promise<GrokLeader> {
    if (disposed) throw new Error('Grok backend is disposed');
    if (leader) await stop(leader);

    // macOS /tmp is a symlink the native socket bind rejects; use its real path.
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-grok-'));
    const socketPath = join(directory, 'leader.sock');
    if (!grokLeaderSocketFits(socketPath)) {
      rmSync(directory, { recursive: true, force: true });
      // Grok would never bind it, and the readiness wait below would spend 20 s saying nothing.
      throw new Error(`Grok leader socket path is too long for this platform: ${socketPath}`);
    }
    const readinessPath = grokLeaderReadinessPath(socketPath);
    const startedAtMs = Date.now();
    const child = spawn(
      options.executable,
      ['agent', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--leader-socket', socketPath],
      { stdio: 'ignore', env: options.env },
    );
    const candidate = { startedAtMs, socketPath, readinessPath, directory, child };
    startingLeader = candidate;
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error;
    });
    try {
      for (let attempt = 0; attempt < 80 && !existsSync(readinessPath); attempt += 1) {
        if (disposed || spawnError || child.exitCode !== null || child.signalCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (disposed) throw new Error('Grok backend was disposed while its leader was starting');
      if (!existsSync(readinessPath)) {
        const detail = spawnError
          ? `: ${spawnError.message}`
          : child.exitCode === null
            ? ''
            : `, exit ${child.exitCode}`;
        throw new Error(`grok agent leader failed to start (no readiness signal${detail})`);
      }
      leader = candidate;
      startingLeader = undefined;
      return candidate;
    } catch (error) {
      await stop(candidate);
      throw error;
    }
  }

  async function ensure(): Promise<string> {
    if (disposed) throw new Error('Grok backend is disposed');
    if (live(leader)) return leader.socketPath;
    if (leader) await stop(leader);
    const pending = leaderPromise ?? start();
    leaderPromise = pending;
    try {
      return (await pending).socketPath;
    } finally {
      if (leaderPromise === pending) leaderPromise = undefined;
    }
  }

  return {
    ensure,
    helper() {
      return live(leader) ? { pid: leader.child.pid, startedAtMs: leader.startedAtMs } : undefined;
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      disposal = Promise.all([stop(startingLeader), stop(leader)]).then(() => undefined);
      return disposal;
    },
  };
}
