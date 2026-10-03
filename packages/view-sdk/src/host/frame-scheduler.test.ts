// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFrameScheduler } from './frame-scheduler.js';

function manualFrames() {
  const pending: (() => void)[] = [];
  return {
    requestFrame: (run: () => void) => {
      pending.push(run);
    },
    step: () => {
      for (const run of pending.splice(0)) run();
    },
    get pending() {
      return pending.length;
    },
  };
}

describe('createFrameScheduler', () => {
  it('runs work at the next frame, not before, asking the platform for one frame however much is queued', () => {
    const frames = manualFrames();
    const scheduler = createFrameScheduler(frames.requestFrame);
    const log: string[] = [];
    scheduler.request(() => log.push('a'));
    scheduler.request(() => log.push('b'));
    expect(log).toEqual([]);
    expect(frames.pending).toBe(1);
    frames.step();
    expect(log).toEqual(['a', 'b']);
    expect(frames.pending).toBe(0);
  });

  it('lets work requested by another piece of work join the frame that is running', () => {
    const frames = manualFrames();
    const scheduler = createFrameScheduler(frames.requestFrame);
    const log: string[] = [];
    const slot = () => log.push('slot');
    scheduler.request(() => {
      log.push('replica');
      scheduler.request(slot);
    });
    frames.step();
    expect(log).toEqual(['replica', 'slot']);
    expect(frames.pending).toBe(0);
  });

  it('holds work that already ran this frame until the next one, so nothing runs twice in a frame', () => {
    const frames = manualFrames();
    const scheduler = createFrameScheduler(frames.requestFrame);
    let runs = 0;
    const work = () => {
      runs += 1;
      if (runs < 3) scheduler.request(work);
    };
    scheduler.request(work);
    frames.step();
    expect(runs).toBe(1);
    frames.step();
    expect(runs).toBe(2);
    frames.step();
    expect(runs).toBe(3);
    frames.step();
    expect(runs).toBe(3);
  });

  it('runs the same work once however often it was queued for the frame', () => {
    const frames = manualFrames();
    const scheduler = createFrameScheduler(frames.requestFrame);
    const work = vi.fn();
    scheduler.request(work);
    scheduler.request(work);
    frames.step();
    expect(work).toHaveBeenCalledOnce();
  });

  it('cancels', () => {
    const frames = manualFrames();
    const scheduler = createFrameScheduler(frames.requestFrame);
    const work = vi.fn();
    const cancel = scheduler.request(work);
    cancel();
    frames.step();
    expect(work).not.toHaveBeenCalled();
  });

  it('keeps the rest of the frame when one piece of work throws, and reports the error', async () => {
    const frames = manualFrames();
    const scheduler = createFrameScheduler(frames.requestFrame);
    const after = vi.fn();
    const failure = new Error('view broke');
    const uncaught = vi.fn();
    const reportError = vi.fn((error: unknown) => uncaught(error));
    vi.stubGlobal('reportError', reportError);
    try {
      scheduler.request(() => {
        throw failure;
      });
      scheduler.request(after);
      frames.step();
      expect(after).toHaveBeenCalledOnce();
      expect(uncaught).toHaveBeenCalledWith(failure);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
