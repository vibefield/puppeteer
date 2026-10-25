import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GROK_LEADER_EXIT_GRACE_MS, grokLeaderReadinessPath, stopGrokLeaderProcess } from './leader.js';

describe('Grok leader readiness', () => {
  it('waits for the Unix socket where the listener is materialized', () => {
    expect(grokLeaderReadinessPath('/tmp/run/leader.sock', 'darwin')).toBe('/tmp/run/leader.sock');
    expect(grokLeaderReadinessPath('/tmp/run/leader.sock', 'linux')).toBe('/tmp/run/leader.sock');
  });

  it('waits for the adjacent process lock when the listener is a Windows named pipe', () => {
    expect(grokLeaderReadinessPath('C:\\Temp\\run\\leader.sock', 'win32')).toBe('C:\\Temp\\run\\leader.lock');
  });
});

/** A leader that, like Grok 1.0.70, drains for `drainMs` after SIGTERM. */
function drainingLeader(drainMs: number | undefined) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => boolean>>;
  };
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn<(signal: NodeJS.Signals) => boolean>((signal) => {
    const exit = (code: number | null, by: NodeJS.Signals | null) => {
      child.exitCode = code;
      child.signalCode = by;
      child.emit('exit', code, by);
    };
    if (signal === 'SIGKILL') setTimeout(() => exit(null, 'SIGKILL'), 0);
    else if (drainMs !== undefined) setTimeout(() => exit(143, null), drainMs);
    return true;
  });
  return child;
}

describe('Grok leader shutdown', () => {
  afterEach(() => vi.useRealTimers());

  it('removes the leader directory only after the draining leader has exited', async () => {
    vi.useFakeTimers();
    const child = drainingLeader(2_010);
    const cleanup = vi.fn();
    let stopped = false;
    const stopping = stopGrokLeaderProcess(child, cleanup).then(() => {
      stopped = true;
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cleanup).not.toHaveBeenCalled();
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    await stopping;
    expect(cleanup).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('escalates to SIGKILL after the grace period and still cleans up', async () => {
    vi.useFakeTimers();
    const child = drainingLeader(undefined);
    const cleanup = vi.fn();
    const stopping = stopGrokLeaderProcess(child, cleanup);
    await vi.advanceTimersByTimeAsync(GROK_LEADER_EXIT_GRACE_MS - 1);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(cleanup).toHaveBeenCalled();
  });

  it('cleans up at once when the leader already exited or never started', async () => {
    const exited = drainingLeader(0);
    exited.exitCode = 0;
    const cleanupExited = vi.fn();
    await stopGrokLeaderProcess(exited, cleanupExited);
    expect(cleanupExited).toHaveBeenCalledTimes(1);
    expect(exited.kill).not.toHaveBeenCalled();

    const neverStarted = drainingLeader(undefined);
    neverStarted.pid = undefined;
    const cleanupNeverStarted = vi.fn();
    await stopGrokLeaderProcess(neverStarted, cleanupNeverStarted);
    expect(cleanupNeverStarted).toHaveBeenCalledTimes(1);
  });
});
