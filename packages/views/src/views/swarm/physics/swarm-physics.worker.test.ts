// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKER_READY, type WorkerScopeLike } from '@vibefield/puppeteer-view-sdk/toolkit';
import { isSwarmFrame, type SwarmPhysicsCommand } from './protocol.js';
import type { SwarmPhysicsParameters } from './world.js';

// THE PHYSICS THREAD SLEEPS WHILE ITS HOST HOLDS STILL. The worker entry is a timer and a mailbox, and the timer
// follows the host: none before a world is given, none from `pause` to `resume`, none after `dispose`, one while the
// world runs. A timer left armed through a pause wakes the thread at the step rate to solve nothing, for a swarm held
// still or a window nobody is looking at. The entry is loaded as a dedicated worker runs it, `serveWorker` on the
// global scope (its `postMessage`, `onmessage` and `close` stubbed here), with the timers and the clock faked. It has
// top-level effects, so every case loads it fresh.

/** 25 Hz: a 40 ms step, so a running thread's timer wakes every 20 ms, twice a step. */
const PARAMETERS: SwarmPhysicsParameters = { gravityPull: 0.0002, restitution: 0, frictionAir: 0.2, physicsHz: 25 };
const STEP_MS = 40;

const WORLD: SwarmPhysicsCommand = {
  type: 'init',
  agents: ['a', 'b'].map((id) => ({ id, radius: 50 })),
  parameters: PARAMETERS,
  bounds: { width: 800, height: 400 },
  obstacles: [],
  reducedMotion: false,
};

/** The worker's global scope, as `serveWorker` reaches it. */
const scope = globalThis as unknown as WorkerScopeLike;
const posted = vi.fn();
const close = vi.fn();

/** Loads the entry fresh, as a new thread does: it proves itself and starts listening. */
async function serve(): Promise<void> {
  await import('./swarm-physics.worker.js');
}

/** A command, delivered as the platform delivers one: to the scope's `onmessage`. */
function send(command: SwarmPhysicsCommand): void {
  scope.onmessage?.({ data: command } as MessageEvent);
}

/** The frames posted since the spy was last cleared: a frame is a bare Float32Array (protocol.ts). */
const frames = (): number => posted.mock.calls.filter(([message]) => isSwarmFrame(message)).length;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
  posted.mockClear();
  close.mockClear();
  vi.stubGlobal('postMessage', posted);
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('close', close);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the physics thread's clock", () => {
  it('keeps one timer while a world runs, a rate change included, and lets it go with the thread', async () => {
    await serve();
    expect(posted).toHaveBeenNthCalledWith(1, WORKER_READY);
    expect(vi.getTimerCount()).toBe(0);
    send(WORLD);
    expect(vi.getTimerCount()).toBe(1);
    send({ type: 'updateBounds', bounds: { width: 640, height: 400 } });
    send({ type: 'updateParameters', parameters: { ...PARAMETERS, physicsHz: 50 } });
    expect(vi.getTimerCount()).toBe(1);
    send({ type: 'dispose' });
    expect(vi.getTimerCount()).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sleeps from pause to resume, and publishes a frame one step after it wakes', async () => {
    await serve();
    send(WORLD);
    send({ type: 'pause' });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(STEP_MS * 10);
    send({ type: 'resume' });
    expect(vi.getTimerCount()).toBe(1);
    posted.mockClear();
    vi.advanceTimersByTime(STEP_MS);
    expect(frames()).toBe(1);
  });

  it('arms nothing for a rate change while paused, and steps at that rate when it wakes', async () => {
    await serve();
    send(WORLD);
    send({ type: 'pause' });
    send({ type: 'updateParameters', parameters: { ...PARAMETERS, physicsHz: 50 } });
    expect(vi.getTimerCount()).toBe(0);
    send({ type: 'resume' });
    expect(vi.getTimerCount()).toBe(1);
    posted.mockClear();
    // One 50 Hz step: the world took the rate it was given while the thread slept.
    vi.advanceTimersByTime(STEP_MS / 2);
    expect(frames()).toBe(1);
  });

  it('keeps no timer before it has a world, nor for a world that arrives paused', async () => {
    await serve();
    send({ type: 'updateParameters', parameters: PARAMETERS });
    expect(vi.getTimerCount()).toBe(0);
    // A swarm held still before its stage is measured: `pause` goes down first, its world after.
    send({ type: 'pause' });
    send(WORLD);
    expect(vi.getTimerCount()).toBe(0);
    send({ type: 'resume' });
    expect(vi.getTimerCount()).toBe(1);
  });
});
