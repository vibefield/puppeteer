import { describe, expect, it, vi } from 'vitest';
import { createSystemMonitorClock } from './clock.js';

describe('createSystemMonitorClock', () => {
  it('provides current time and cancellable scheduled work', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'));
      const clock = createSystemMonitorClock();
      expect(clock.now().toISOString()).toBe('2026-08-16T12:00:00.000Z');

      const cancelled = vi.fn();
      clock.schedule(10, cancelled).cancel();
      const delivered = vi.fn();
      clock.schedule(10, delivered);
      vi.advanceTimersByTime(10);

      expect(cancelled).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
