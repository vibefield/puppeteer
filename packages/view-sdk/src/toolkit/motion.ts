// A LOOP THAT HONOURS THE THEME: the host's animations switch, the person's
// reduced-motion preference and the stage out of sight all arrive in
// `MonitorTheme`, and while any of them says no, NO animation frame is
// requested at all — not a loop that runs and draws nothing (the conformance
// rule: no loop when off). The view adds its own demand (`moving`): with
// nothing moving, no frame either. A view whose loop is stopped asks for one
// still frame per change instead (`requestStill`): requests merge, so a burst
// of changes is drawn once. Out of sight even that waits: the still frame is
// owed, and drawn once when the stage is shown.
//
// The optional rate cap is the rain's accumulator, ported as it was: frames
// still ride the display (so a hidden window stops them), and a deliberately
// chunky sub-60 cadence skips frames until a step's worth of time has passed.

import type { MonitorTheme } from '../view.js';

export interface MotionLoopOptions {
  /** The host's animations switch (`MonitorTheme.animations`). Off: no loop runs. */
  readonly animations: boolean;
  /** The person asked for reduced motion (`MonitorTheme.reducedMotion`): no loop runs. */
  readonly reducedMotion: boolean;
  /**
   * The stage is out of sight (`MonitorTheme.hidden`): no loop runs, and no still frame is drawn; one asked for is
   * owed until the stage is shown. Absent: false. Take it from the theme through `themeMotion`.
   */
  readonly hidden?: boolean | undefined;
  /** The view has something moving. False: no loop runs, whatever the theme allows. Absent: true. */
  readonly moving?: boolean | undefined;
  /** At most this many frames a second; never more than the display's. Absent: every frame. */
  readonly fps?: number | undefined;
  /**
   * What a still frame draws (`requestStill`). Read once, at creation: `update` never takes it. Absent: the
   * callback with no time passed, `callback(time, 0)`.
   */
  readonly still?: ((time: number) => void) | undefined;
}

/** The theme's three switches as a loop takes them (`themeMotion`). */
export interface ThemeMotion {
  readonly animations: boolean;
  readonly reducedMotion: boolean;
  readonly hidden: boolean;
}

/**
 * The theme's switches for `createMotionLoop` and `loop.update`, an absent `hidden` read as false. Pass the theme
 * through it, never straight in: `update` keeps a key it is not given, so a host that drops `hidden` would leave the
 * loop out of sight.
 */
export function themeMotion(theme: Pick<MonitorTheme, 'animations' | 'reducedMotion' | 'hidden'>): ThemeMotion {
  return { animations: theme.animations, reducedMotion: theme.reducedMotion, hidden: theme.hidden === true };
}

/** Motion is allowed: animations on, motion not reduced, the stage in sight. What a view's own eases and tweens ask. */
export function motionAllowed(theme: Pick<MonitorTheme, 'animations' | 'reducedMotion' | 'hidden'>): boolean {
  return theme.animations && !theme.reducedMotion && theme.hidden !== true;
}

/** Where frames come from. The default is the display's; a fixture drives its own. */
export interface FrameScheduler {
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
  now(): number;
}

export interface MotionLoop {
  /**
   * A frame is scheduled: animations are on, motion is not reduced, the stage is in sight and the view has something
   * moving. A still frame asked for never counts.
   */
  readonly running: boolean;
  /**
   * Re-evaluates after the inputs changed: starts or stops the loop, or takes
   * a new rate. Only the keys given change, so `loop.update(themeMotion(theme))`
   * keeps the rate the loop was made with.
   */
  update(changes: Partial<Omit<MotionLoopOptions, 'still'>>): void;
  /**
   * Asks for one still frame while the loop is stopped: `still(time)` on the next frame. Requests merge, so a burst
   * of changes is drawn once; a request made inside the still draw asks for the frame after it (a fade drawn frame by
   * frame). Nothing while the loop runs (its next frame draws), and nothing once disposed. Out of sight it draws
   * nothing and the still is owed: drawn once when the stage is shown and the loop stays stopped. A loop that starts
   * drops a still it owed.
   */
  requestStill(): void;
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
 * Calls `callback(time, deltaMs)` on each frame while motion is allowed and
 * the view has something moving. `time` is the frame's timestamp; `deltaMs` is
 * the time since the previous call, never negative, and since the loop
 * (re)started for the first call, so a pause never arrives as one giant step.
 */
export function createMotionLoop(
  callback: (time: number, deltaMs: number) => void,
  options: MotionLoopOptions,
  scheduler: FrameScheduler = animationFrameScheduler(),
): MotionLoop {
  let animations = options.animations;
  let reducedMotion = options.reducedMotion;
  let hidden = options.hidden === true;
  let moving = options.moving !== false;
  let fps = options.fps;
  const still = options.still ?? ((time: number) => callback(time, 0));
  let disposed = false;
  let handle: number | undefined;
  /** The one still frame asked for while the loop is stopped: a handle of its own, never the loop's. */
  let stillHandle: number | undefined;
  /** A still frame asked for out of sight: drawn once the stage is shown, unless the loop starts and draws it. */
  let owed = false;
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

  const drawStill = (time: number): void => {
    // Cleared before the draw, so a request made inside it asks for the next frame.
    stillHandle = undefined;
    // A loop started earlier in this same frame draws it; a scheduler may run a callback cancelled mid-frame.
    if (handle !== undefined || disposed) return;
    // Out of sight since it was asked for: owed until the stage is shown.
    if (hidden) owed = true;
    else still(time);
  };

  const requestStillFrame = (): void => {
    if (stillHandle === undefined) stillHandle = scheduler.request(drawStill);
  };

  const cancelStill = (): void => {
    if (stillHandle === undefined) return;
    scheduler.cancel(stillHandle);
    stillHandle = undefined;
  };

  const reconcile = (): void => {
    const wanted = !disposed && animations && !reducedMotion && !hidden && moving;
    if (wanted && handle === undefined) {
      // The loop's frames draw: a still owed from before it started is dropped.
      cancelStill();
      owed = false;
      previousTime = scheduler.now();
      drawnAt = previousTime;
      accumulated = 0;
      handle = scheduler.request(tick);
    } else if (!wanted && handle !== undefined) {
      scheduler.cancel(handle);
      handle = undefined;
    }
    if (handle !== undefined || disposed) return;
    if (hidden) {
      // Out of sight, a still frame asked for and not yet drawn waits for the stage to be shown.
      if (stillHandle !== undefined) {
        cancelStill();
        owed = true;
      }
    } else if (owed) {
      // Shown with the loop stopped: the still owed is drawn once, on the next frame.
      owed = false;
      requestStillFrame();
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
      if (changes.hidden !== undefined) hidden = changes.hidden;
      if (changes.moving !== undefined) moving = changes.moving;
      if ('fps' in changes) fps = changes.fps;
      reconcile();
    },
    requestStill() {
      if (disposed || handle !== undefined) return;
      if (hidden) owed = true;
      else requestStillFrame();
    },
    dispose() {
      disposed = true;
      owed = false;
      cancelStill();
      reconcile();
    },
  };
}
