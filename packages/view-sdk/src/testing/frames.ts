/**
 * Frames by hand: a stand-in for `requestAnimationFrame` that runs only when a
 * test steps it, and counts every request.
 *
 * Installed, it is the page's animation frame, so it sees a view's own loops
 * (the conformance suite's motion check) as well as the slot's frame work
 * (`driver.scheduler`). A loop shows as work still pending after the frames a
 * one-shot paint would need.
 */

import { createFrameScheduler } from '../host/frame-scheduler.js';
import type { FrameScheduler } from '../model.js';
import type { FixtureClock } from './clock.js';
import { overrideProperty } from './override.js';

export interface FrameDriverOptions {
  /** Milliseconds a frame lasts. Defaults to 1000 / 60. */
  readonly frameMs?: number | undefined;
  /** Advanced by `frameMs` before each frame runs; its `elapsed()` is the frame's timestamp. */
  readonly clock?: FixtureClock | undefined;
  /**
   * A callback that threw. The rest of its frame still runs, as on the
   * platform. Absent, the frame's first error is rethrown once the frame is done.
   */
  readonly onError?: ((error: unknown) => void) | undefined;
}

export interface FrameDriver {
  /** Runs the next `count` frames (default 1): each runs what was requested before it began. Returns callbacks run. */
  step(count?: number): number;
  /** Drops every callback waiting for the next frame (a leaked loop, after its failure is recorded). */
  clear(): void;
  /** Callbacks waiting for the next frame. */
  readonly pending: number;
  /** Callbacks requested since the driver began. */
  readonly requested: number;
  /** Callbacks run since the driver began. */
  readonly ran: number;
  /** Frames stepped since the driver began. */
  readonly frames: number;
  /** The last frame's timestamp. */
  readonly time: number;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
  /** A slot scheduler on these frames: `createViewSlot(…, { scheduler: driver.scheduler })`. */
  readonly scheduler: FrameScheduler;
  /** Makes this the page's animation frame until the returned function restores the original. */
  install(): () => void;
}

export function createFrameDriver(options: FrameDriverOptions = {}): FrameDriver {
  const frameMs = options.frameMs ?? 1000 / 60;
  let queue = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  let requested = 0;
  let ran = 0;
  let frames = 0;
  let time = options.clock?.elapsed() ?? 0;

  const requestFrame = (callback: FrameRequestCallback): number => {
    requested += 1;
    const handle = nextHandle;
    nextHandle += 1;
    queue.set(handle, callback);
    return handle;
  };
  const cancelFrame = (handle: number): void => {
    queue.delete(handle);
  };

  const driver: FrameDriver = {
    step(count = 1) {
      let callbacks = 0;
      for (let frame = 0; frame < count; frame += 1) {
        if (options.clock) {
          options.clock.advance(frameMs);
          time = options.clock.elapsed();
        } else {
          time += frameMs;
        }
        frames += 1;
        // A callback requested during this frame waits for the next, as the platform's do.
        const running = queue;
        queue = new Map();
        let failure: { error: unknown } | undefined;
        for (const callback of running.values()) {
          callbacks += 1;
          ran += 1;
          try {
            callback(time);
          } catch (error) {
            if (options.onError) options.onError(error);
            else failure ??= { error };
          }
        }
        if (failure !== undefined) throw failure.error;
      }
      return callbacks;
    },
    clear() {
      queue.clear();
    },
    get pending() {
      return queue.size;
    },
    get requested() {
      return requested;
    },
    get ran() {
      return ran;
    },
    get frames() {
      return frames;
    },
    get time() {
      return time;
    },
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    scheduler: createFrameScheduler((run) => {
      requestFrame(() => run());
    }),
    install() {
      const targets = new Set<object>([globalThis]);
      if (typeof window !== 'undefined') targets.add(window);
      const restores = [...targets].flatMap((target) => [
        overrideProperty(target, 'requestAnimationFrame', requestFrame),
        overrideProperty(target, 'cancelAnimationFrame', cancelFrame),
      ]);
      return () => {
        for (const restore of restores.reverse()) restore();
      };
    },
  };
  return driver;
}
