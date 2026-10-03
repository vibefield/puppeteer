/**
 * When the view host does its work: at most once per frame (L6, MV-D21). The
 * implementation of the contract's `FrameScheduler` (M7), which the replica
 * takes too: a host passes ONE instance to both.
 *
 * A frame drains every piece of work requested for it, each at most once:
 * the same function queued twice runs once. Work requested while a frame
 * drains joins that same frame unless that very work already ran in it, which
 * then waits for the next one. Two things follow:
 * - a replica that notifies from inside a frame reaches a slot sharing the
 *   scheduler in the same frame, so the two batches never stack into an extra
 *   frame of latency;
 * - a slot whose update causes another change (a select that moves the model)
 *   updates again only in the next frame, never twice in one.
 */

import type { FrameScheduler } from '../model.js';

/** Asks the platform for one frame and runs `run` in it. */
export type RequestFrame = (run: () => void) => void;

function animationFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
  else setTimeout(run, 16);
}

function reportUncaught(error: unknown): void {
  // One failing piece of work must not cost the rest of the frame theirs.
  if (typeof reportError === 'function') reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}

interface Entry {
  readonly work: () => void;
  cancelled: boolean;
}

export function createFrameScheduler(requestFrame: RequestFrame = animationFrame): FrameScheduler {
  let queue: Entry[] = [];
  let nextFrame: Entry[] = [];
  let ranThisFrame: Set<() => void> | undefined;
  let framePending = false;

  const drain = (): void => {
    framePending = false;
    const ran = new Set<() => void>();
    ranThisFrame = ran;
    try {
      // The queue may grow while it drains: work joining this frame runs in it.
      for (let index = 0; index < queue.length; index += 1) {
        const entry = queue[index]!;
        if (entry.cancelled || ran.has(entry.work)) continue;
        ran.add(entry.work);
        try {
          entry.work();
        } catch (error) {
          reportUncaught(error);
        }
      }
    } finally {
      ranThisFrame = undefined;
      queue = nextFrame;
      nextFrame = [];
      if (queue.length > 0) schedule();
    }
  };

  const schedule = (): void => {
    if (framePending) return;
    framePending = true;
    requestFrame(drain);
  };

  return {
    request(work) {
      const entry: Entry = { work, cancelled: false };
      if (ranThisFrame === undefined) {
        queue.push(entry);
        schedule();
      } else if (ranThisFrame.has(work)) {
        nextFrame.push(entry);
      } else {
        queue.push(entry);
      }
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

/** The scheduler every slot uses unless its host passes one: one per document, on the animation frame. */
export const frameScheduler: FrameScheduler = createFrameScheduler();
