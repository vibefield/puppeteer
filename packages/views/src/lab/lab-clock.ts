import { seededRandom } from './lab-world.js';

// The capture clock (MV-0): a lab page opened with `capture=1` runs on virtual
// time, so a golden is the same pixels on every run. The wall clock reads the
// fixed `nowMs` plus the virtual time elapsed, `performance.now()` reads the
// virtual time alone, `Math.random` is seeded, and animation frames run only
// when the capture tool steps them, at an exact 60 Hz. Timers and message
// channels stay real, so React's scheduler still commits between frames.
//
// It replaces globals for the page's whole life, which is why only a lab, and
// only in capture mode, installs it.

export interface LabClock {
  /** Run `frames` animation frames of virtual time in order, letting React commit after each, then let the compositor present. */
  step(frames: number): Promise<void>;
  /** The wall clock the page reads now. */
  now(): number;
}

const FRAME_MS = 1000 / 60;

/** A turn of the real event loop: React's scheduler flushes on a message, so a macrotask is enough. */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function installLabClock({ nowMs, seed }: { nowMs: number; seed: string }): LabClock {
  const realFrame = window.requestAnimationFrame.bind(window);
  // Where `performance.now()` starts: arbitrary, but fixed, and clear of zero.
  const origin = 1000;
  let elapsed = 0;
  Date.now = () => nowMs + elapsed;
  performance.now = () => origin + elapsed;
  Math.random = seededRandom(`${seed}:random`);
  let nextId = 1;
  const queued = new Map<number, FrameRequestCallback>();
  window.requestAnimationFrame = (callback) => {
    const id = nextId;
    nextId += 1;
    queued.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queued.delete(id);
  };
  const presented = (): Promise<void> => new Promise((resolve) => realFrame(() => resolve()));
  return {
    now: () => nowMs + elapsed,
    async step(frames) {
      for (let frame = 0; frame < frames; frame += 1) {
        elapsed += FRAME_MS;
        // Callbacks queued by these callbacks wait for the next frame, as in a browser.
        const due = [...queued.values()];
        queued.clear();
        for (const callback of due) callback(origin + elapsed);
        await macrotask();
        await macrotask();
      }
      await presented();
      await presented();
    },
  };
}
