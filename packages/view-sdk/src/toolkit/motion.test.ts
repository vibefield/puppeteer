import { describe, expect, it } from 'vitest';
import { createMotionLoop, type FrameScheduler } from './motion.js';

/** Frames on demand: `frame(t)` runs whatever is scheduled at timestamp `t`. */
function fakeFrames(startAt = 0) {
  let next = 1;
  let clock = startAt;
  const pending = new Map<number, (time: number) => void>();
  let requests = 0;
  const scheduler: FrameScheduler = {
    request(callback) {
      requests += 1;
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    now: () => clock,
  };
  return {
    scheduler,
    get scheduled() {
      return pending.size;
    },
    get requests() {
      return requests;
    },
    frame(time: number) {
      clock = time;
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(time);
    },
  };
}

describe('the motion loop', () => {
  it('requests no frame at all while animations are off or motion is reduced', () => {
    for (const options of [
      { animations: false, reducedMotion: false },
      { animations: true, reducedMotion: true },
      { animations: false, reducedMotion: true },
    ]) {
      const frames = fakeFrames();
      const loop = createMotionLoop(() => {}, options, frames.scheduler);
      expect(loop.running).toBe(false);
      expect(frames.requests).toBe(0);
    }
  });

  it('runs every frame while on, passing the time and the time since the last call', () => {
    const frames = fakeFrames(1000);
    const calls: [number, number][] = [];
    const loop = createMotionLoop(
      (time, delta) => calls.push([time, delta]),
      { animations: true, reducedMotion: false },
      frames.scheduler,
    );
    expect(loop.running).toBe(true);
    frames.frame(1016);
    frames.frame(1033);
    expect(calls).toEqual([
      [1016, 16],
      [1033, 17],
    ]);
  });

  it('stops and starts when the theme changes, with no giant step after a pause', () => {
    const frames = fakeFrames(0);
    const deltas: number[] = [];
    const loop = createMotionLoop(
      (_time, delta) => deltas.push(delta),
      { animations: true, reducedMotion: false },
      frames.scheduler,
    );
    frames.frame(16);
    loop.update({ reducedMotion: true });
    expect(loop.running).toBe(false);
    expect(frames.scheduled).toBe(0);
    frames.frame(5000);
    loop.update({ reducedMotion: false });
    frames.frame(5016);
    expect(deltas).toEqual([16, 16]);
  });

  it('takes a theme object straight in and keeps the rate it was made with', () => {
    const frames = fakeFrames(0);
    let calls = 0;
    const loop = createMotionLoop(
      () => (calls += 1),
      { animations: false, reducedMotion: false, fps: 10 },
      frames.scheduler,
    );
    const theme = { scheme: 'dark' as const, animations: true, reducedMotion: false };
    loop.update(theme);
    for (let time = 16; time <= 1000; time += 16) frames.frame(time);
    expect(calls).toBeGreaterThanOrEqual(9);
    expect(calls).toBeLessThanOrEqual(10);
  });

  it("caps the rate with the rain's accumulator", () => {
    const frames = fakeFrames(0);
    const times: number[] = [];
    createMotionLoop((time) => times.push(time), { animations: true, reducedMotion: false, fps: 20 }, frames.scheduler);
    for (let time = 16; time <= 160; time += 16) frames.frame(time);
    // 50 ms a step at 60 Hz frames: the first frame past each step's worth of time.
    expect(times).toEqual([64, 112, 160]);
  });

  it('can be stopped from inside its own callback', () => {
    const frames = fakeFrames(0);
    let calls = 0;
    const loop = createMotionLoop(
      () => {
        calls += 1;
        loop.update({ animations: false });
      },
      { animations: true, reducedMotion: false },
      frames.scheduler,
    );
    frames.frame(16);
    frames.frame(32);
    expect(calls).toBe(1);
    expect(frames.scheduled).toBe(0);
  });

  it('never runs again once disposed', () => {
    const frames = fakeFrames(0);
    let calls = 0;
    const loop = createMotionLoop(() => (calls += 1), { animations: true, reducedMotion: false }, frames.scheduler);
    loop.dispose();
    loop.update({ animations: true });
    frames.frame(16);
    expect(calls).toBe(0);
    expect(loop.running).toBe(false);
  });
});
