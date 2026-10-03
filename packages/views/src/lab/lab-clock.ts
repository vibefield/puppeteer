import { seededRandom } from './lab-world.js';

// The capture clock (MV-0): a lab page opened with `capture=1` runs on virtual
// time, so a golden is the same pixels on every run. The wall clock stands at
// the fixed `nowMs`, `performance.now()` reads the virtual time, `Math.random`
// is seeded, and animation frames run only when the capture tool steps them,
// at an exact 60 Hz. Timers and message channels stay real, so React's
// scheduler still commits between frames.
//
// The wall clock does not move with the frames on purpose. Resize observers are
// delivered on the REAL frames, so they land between virtual ones at a
// different point on every run; a view that reads the time there (the
// timeline's scale does) drew its axis a fraction of a pixel apart from run to
// run while the clock advanced.
//
// It replaces globals for the page's whole life, which is why only a lab, and
// only in capture mode, installs it.

export interface LabClock {
  /** Let the real frames run until layout, its observers and the commits they cause have settled. */
  settle(): Promise<void>;
  /** Run `frames` animation frames of virtual time in order, letting React commit after each, then let the compositor present. */
  step(frames: number): Promise<void>;
}

const FRAME_MS = 1000 / 60;

/** A turn of the real event loop: React's scheduler flushes on a message, so a macrotask is enough. */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export function installLabClock({ nowMs, seed }: { nowMs: number; seed: string }): LabClock {
  const realFrame = window.requestAnimationFrame.bind(window);
  // Where `performance.now()` starts: arbitrary, but fixed, and clear of zero.
  const origin = 1000;
  let elapsed = 0;
  Date.now = () => nowMs;
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
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 3; round += 1) {
      await presented();
      await macrotask();
    }
  };
  return {
    settle,
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
      await settle();
    },
  };
}
