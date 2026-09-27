import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processStartedAt, watchProcessExit } from './process-watch.js';

const sleepers: ChildProcess[] = [];
function sleeper(): ChildProcess & { pid: number } {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  sleepers.push(child);
  if (child.pid === undefined) throw new Error('sleep did not start');
  return child as ChildProcess & { pid: number };
}
async function kill(child: ChildProcess): Promise<void> {
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
afterEach(() => {
  for (const child of sleepers.splice(0)) child.kill('SIGKILL');
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('watchProcessExit', { timeout: 60_000 }, () => {
  it('fires once when the process is gone, and not again', async () => {
    const child = sleeper();
    const onExit = vi.fn();
    watchProcessExit(child.pid, { intervalMs: 20 }, onExit);
    await pause(100);
    expect(onExit).not.toHaveBeenCalled();

    await kill(child);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await pause(100);
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('stops polling when told to', async () => {
    const child = sleeper();
    const onExit = vi.fn();
    const stop = watchProcessExit(child.pid, { intervalMs: 20 }, onExit);
    stop();
    await kill(child);
    await pause(150);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("gives the terminal's own exit report its grace, and a stop during it cancels the exit", async () => {
    const reported = sleeper();
    const onReported = vi.fn();
    watchProcessExit(reported.pid, { intervalMs: 20, graceMs: 300 }, onReported);
    await kill(reported);
    const killedAt = Date.now();
    await pause(150);
    expect(onReported).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onReported).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(280);

    const cancelled = sleeper();
    const onCancelled = vi.fn();
    const stop = watchProcessExit(cancelled.pid, { intervalMs: 20, graceMs: 300 }, onCancelled);
    await kill(cancelled);
    await pause(120);
    stop();
    await pause(400);
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("takes a pid it may not signal (another user's) for alive", async () => {
    const onExit = vi.fn();
    const stop = watchProcessExit(1, { intervalMs: 20 }, onExit);
    await pause(150);
    stop();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("never holds the host's exit", () => {
    const child = sleeper();
    // A second Node imports the module itself (it has no relative imports, so type stripping runs it).
    const module = new URL('./process-watch.ts', import.meta.url).href;
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { watchProcessExit } from ${JSON.stringify(module)};` +
          `watchProcessExit(${child.pid}, { intervalMs: 50 }, () => {}); console.log('armed');`,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.stdout.trim()).toBe('armed');
    // A ref'd interval keeps that Node alive for ever: the bound only allows a slow start on a loaded host.
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});

describe('processStartedAt', { timeout: 60_000 }, () => {
  it('is stable for a live pid and undefined for a gone one', async () => {
    const child = sleeper();
    const first = await processStartedAt(child.pid);
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u);
    expect(Math.abs(Date.parse(first!) - Date.now())).toBeLessThan(60_000);
    await pause(1_100);
    expect(await processStartedAt(child.pid)).toBe(first);

    await kill(child);
    expect(await processStartedAt(child.pid)).toBeUndefined();
    expect(await processStartedAt(0)).toBeUndefined();
    expect(await processStartedAt(-1)).toBeUndefined();
  });
});
