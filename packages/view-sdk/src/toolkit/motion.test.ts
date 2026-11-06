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

describe('a still frame, asked for while the loop is stopped', () => {
  it('draws once on the next frame however many ask, and never counts as running', () => {
    const frames = fakeFrames(0);
    const moving: number[] = [];
    const stills: number[] = [];
    const loop = createMotionLoop(
      (time) => moving.push(time),
      { animations: true, reducedMotion: true, still: (time) => stills.push(time) },
      frames.scheduler,
    );
    loop.requestStill();
    loop.requestStill();
    expect(frames.requests).toBe(1);
    expect(loop.running).toBe(false);
    expect(stills).toEqual([]);
    frames.frame(16);
    expect(stills).toEqual([16]);
    expect(moving).toEqual([]);
    expect(frames.scheduled).toBe(0);
    frames.frame(32);
    expect(stills).toEqual([16]);
  });

  it('draws with the callback and no time passed when it is given no still of its own', () => {
    const frames = fakeFrames(0);
    const calls: [number, number][] = [];
    const loop = createMotionLoop(
      (time, delta) => calls.push([time, delta]),
      { animations: false, reducedMotion: false },
      frames.scheduler,
    );
    loop.requestStill();
    frames.frame(16);
    expect(calls).toEqual([[16, 0]]);
  });

  it('asks for one more frame when the still draw asks again: a fade drawn frame by frame, then nothing', () => {
    const frames = fakeFrames(0);
    const stills: number[] = [];
    const loop = createMotionLoop(
      () => {},
      {
        animations: true,
        reducedMotion: true,
        still: (time) => {
          stills.push(time);
          if (stills.length < 3) loop.requestStill();
        },
      },
      frames.scheduler,
    );
    loop.requestStill();
    for (let time = 16; time <= 96; time += 16) frames.frame(time);
    expect(stills).toEqual([16, 32, 48]);
    expect(frames.requests).toBe(3);
    expect(frames.scheduled).toBe(0);
  });

  it('asks for nothing while the loop runs, and a loop that starts drops the still it owed', () => {
    const frames = fakeFrames(0);
    const stills: number[] = [];
    const loop = createMotionLoop(
      () => {},
      { animations: true, reducedMotion: false, still: (time) => stills.push(time) },
      frames.scheduler,
    );
    // The loop's own frame and no other: its next frame draws anyway.
    loop.requestStill();
    expect(frames.requests).toBe(1);
    loop.update({ reducedMotion: true });
    loop.requestStill();
    expect(frames.scheduled).toBe(1);
    loop.update({ reducedMotion: false });
    expect(frames.scheduled).toBe(1);
    frames.frame(16);
    expect(stills).toEqual([]);
  });

  it('draws no still in a frame the loop has started in: the loop draws it', () => {
    const frames = fakeFrames(0);
    const stills: number[] = [];
    const loop = createMotionLoop(
      () => {},
      { animations: true, reducedMotion: true, still: (time) => stills.push(time) },
      frames.scheduler,
    );
    // Earlier in the same frame, something starts the loop after the still was already due.
    frames.scheduler.request(() => loop.update({ reducedMotion: false }));
    loop.requestStill();
    frames.frame(16);
    expect(stills).toEqual([]);
    expect(loop.running).toBe(true);
  });

  it('asks for nothing once disposed, and disposing drops the still it owed', () => {
    const frames = fakeFrames(0);
    const stills: number[] = [];
    const loop = createMotionLoop(
      () => {},
      { animations: false, reducedMotion: false, still: (time) => stills.push(time) },
      frames.scheduler,
    );
    loop.requestStill();
    loop.dispose();
    expect(frames.scheduled).toBe(0);
    loop.requestStill();
    expect(frames.requests).toBe(1);
    frames.frame(16);
    expect(stills).toEqual([]);
  });
});
