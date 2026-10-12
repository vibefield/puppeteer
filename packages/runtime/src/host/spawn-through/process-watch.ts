import { execFile } from 'node:child_process';

export interface WatchProcessExitOptions {
  intervalMs?: number | undefined;
  /**
   * How long to wait, once the pid is gone, before `onExit`: a turn for the
   * host's terminal to report the exit with its own meaning (completed,
   * crashed, asked to stop), which a vanished pid cannot tell. Default 0.
   */
  graceMs?: number | undefined;
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM: the pid exists and belongs to someone else — alive, not ours to signal.
    return (error as NodeJS.ErrnoException).code !== 'EPERM';
  }
}

/**
 * Watch a process the host did not spawn — an adopted agent is the shell's
 * child, so no exit event reaches the host. `onExit` fires once, `graceMs`
 * after the first poll that finds the pid gone; the returned function stops
 * the watch, a pending grace included. No timer of it ever holds the host's
 * own exit. A pid reused between two polls is
 * not seen: a host that must know compares {@link processStartedAt}.
 */
export function watchProcessExit(
  pid: number,
  { intervalMs = 500, graceMs = 0 }: WatchProcessExitOptions,
  onExit: () => void,
): () => void {
  let watching = true;
  let grace: NodeJS.Timeout | undefined;
  const stop = (): void => {
    watching = false;
    clearInterval(timer);
    clearTimeout(grace);
  };
  const timer = setInterval(() => {
    if (!watching || !processIsGone(pid)) return;
    clearInterval(timer);
    if (graceMs <= 0) {
      stop();
      onExit();
      return;
    }
    grace = setTimeout(() => {
      stop();
      onExit();
    }, graceMs);
    grace.unref();
  }, intervalMs);
  timer.unref();
  return stop;
}

/**
 * When `pid` started, as an ISO instant, from `ps -o lstart=` (second
 * resolution); `undefined` when the pid is gone or `ps` cannot say. A host
 * records it beside an adopted pid and compares it after its own restart, so
 * a pid the system reused is never taken for the agent it adopted.
 */
export function processStartedAt(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      // The C locale keeps the date in the one format Date.parse reads.
      { env: { ...process.env, LC_ALL: 'C' }, timeout: 5_000 },
      (error, stdout) => {
        const text = error ? '' : stdout.trim();
        const started = text ? Date.parse(text) : Number.NaN;
        resolve(Number.isNaN(started) ? undefined : new Date(started).toISOString());
      },
    );
  });
}
