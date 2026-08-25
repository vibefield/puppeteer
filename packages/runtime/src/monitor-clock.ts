export interface MonitorScheduledTask {
  cancel(): void;
}

/** Runtime-owned wall-clock and scheduler boundary for deterministic monitor tests. */
export interface MonitorClock {
  now(): Date;
  schedule(delayMs: number, callback: () => void): MonitorScheduledTask;
}

export function createSystemMonitorClock(): MonitorClock {
  return {
    now: () => new Date(),
    schedule(delayMs, callback) {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new RangeError('monitor schedule delayMs must be a non-negative finite number');
      }
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    },
  };
}
