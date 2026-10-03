// A LOOP THAT HONOURS THE THEME: the host's animations switch and the
// person's reduced-motion preference both arrive in `MonitorTheme`, and while
// either says no, NO animation frame is requested at all — not a loop that
// runs and draws nothing (the conformance rule: no loop when off). A view
// whose loop is stopped draws once in `update` instead.
//
// The optional rate cap is the rain's accumulator, ported as it was: frames
// still ride the display (so a hidden window stops them), and a deliberately
// chunky sub-60 cadence skips frames until a step's worth of time has passed.

export interface MotionLoopOptions {
  /** The host's animations switch (`MonitorTheme.animations`). Off: no loop runs. */
  readonly animations: boolean;
  /** The person asked for reduced motion (`MonitorTheme.reducedMotion`): no loop runs. */
  readonly reducedMotion: boolean;
  /** At most this many frames a second; never more than the display's. Absent: every frame. */
  readonly fps?: number | undefined;
}

/** Where frames come from. The default is the display's; a fixture drives its own. */
export interface FrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
  now(): number;
}

export interface MotionLoop {
  /** A frame is scheduled: animations are on and motion is not reduced. */
  readonly running: boolean;
  /**
   * Re-evaluates after the inputs changed: starts or stops the loop, or takes
   * a new rate. Only the keys given change, so `loop.update(input.theme)` keeps
   * the rate the loop was made with.
   */
  update(changes: Partial<MotionLoopOptions>): void;
  dispose(): void;
}

/** The display's frames: `requestAnimationFrame`, timed against `performance.now()`. */
export function animationFrameScheduler(): FrameScheduler {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
    now: () => performance.now(),
  };
}

/**
 * Calls `callback(time, deltaMs)` on each frame while animations are on and
 * motion is not reduced. `time` is the frame's timestamp; `deltaMs` is the
 * time since the previous call, never negative, and since the loop (re)started
 * for the first call, so a pause never arrives as one giant step.
 */
export function createMotionLoop(
  callback: (time: number, deltaMs: number) => void,
  options: MotionLoopOptions,
  scheduler: FrameScheduler = animationFrameScheduler(),
): MotionLoop {
  let animations = options.animations;
  let reducedMotion = options.reducedMotion;
  let fps = options.fps;
  let disposed = false;
  let handle: number | undefined;
  let previousTime = 0;
  let accumulated = 0;
  let drawnAt = 0;

  const tick = (time: number): void => {
    handle = scheduler.request(tick);
    if (fps !== undefined && fps > 0) {
      accumulated += time - previousTime;
      previousTime = time;
      const interval = 1000 / fps;
      if (accumulated < interval) return;
      accumulated = Math.min(accumulated - interval, interval);
    }
    const deltaMs = Math.max(0, time - drawnAt);
    drawnAt = time;
    callback(time, deltaMs);
  };

  const reconcile = (): void => {
    const wanted = !disposed && animations && !reducedMotion;
    if (wanted && handle === undefined) {
      previousTime = scheduler.now();
      drawnAt = previousTime;
      accumulated = 0;
      handle = scheduler.request(tick);
    } else if (!wanted && handle !== undefined) {
      scheduler.cancel(handle);
      handle = undefined;
    }
  };

  reconcile();
  return {
    get running() {
      return handle !== undefined;
    },
    update(changes) {
      if (changes.animations !== undefined) animations = changes.animations;
      if (changes.reducedMotion !== undefined) reducedMotion = changes.reducedMotion;
      if ('fps' in changes) fps = changes.fps;
      reconcile();
    },
    dispose() {
      disposed = true;
      reconcile();
    },
  };
}
