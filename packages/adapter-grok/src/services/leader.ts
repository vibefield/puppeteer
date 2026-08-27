import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface GrokLeader {
  readonly socketPath: string;
  readonly readinessPath: string;
  readonly directory: string;
  readonly child: ChildProcess;
}

export interface GrokLeaderService {
  ensure(): Promise<string>;
  dispose(): void;
}

export interface CreateGrokLeaderServiceOptions {
  executable: string;
  env?: NodeJS.ProcessEnv;
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

export function createGrokLeaderService(options: CreateGrokLeaderServiceOptions): GrokLeaderService {
  let leader: GrokLeader | undefined;
  let startingLeader: GrokLeader | undefined;
  let leaderPromise: Promise<GrokLeader> | undefined;
  let disposed = false;

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

  const stop = (candidate: GrokLeader | undefined): void => {
    if (!candidate) return;
    candidate.child.once('exit', () => cleanDirectory(candidate));
    try {
      candidate.child.kill('SIGTERM');
    } catch {
      // The leader has already exited.
    }
    cleanDirectory(candidate);
    if (leader === candidate) leader = undefined;
    if (startingLeader === candidate) startingLeader = undefined;
  };

  async function start(): Promise<GrokLeader> {
    if (disposed) throw new Error('Grok backend is disposed');
    if (leader) stop(leader);

    // macOS /tmp is a symlink the native socket bind rejects; use its real path.
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'puppeteer-grok-'));
    const socketPath = join(directory, 'leader.sock');
    const readinessPath = grokLeaderReadinessPath(socketPath);
    const child = spawn(
      options.executable,
      ['agent', 'leader', '--no-exit-on-disconnect', '--relay-on-demand', '--leader-socket', socketPath],
      { stdio: 'ignore', env: options.env },
    );
    const candidate = { socketPath, readinessPath, directory, child };
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
      stop(candidate);
      throw error;
    }
  }

  async function ensure(): Promise<string> {
    if (disposed) throw new Error('Grok backend is disposed');
    if (live(leader)) return leader.socketPath;
    if (leader) stop(leader);
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop(startingLeader);
      stop(leader);
    },
  };
}
