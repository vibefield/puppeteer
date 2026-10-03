/**
 * A clock that moves only when a test moves it, for goldens and timing tests.
 *
 * `install()` points `Date.now` and `performance.now` at it until the returned
 * function restores them. `new Date()` with no argument is not touched: a view
 * that wants the time reads `Date.now()` (or the model's own timestamps).
 */

import { FIXTURE_EPOCH } from './fixtures.js';

export interface FixtureClock {
  /** Epoch milliseconds, as `Date.now()` answers while installed. */
  now(): number;
  /** Milliseconds since the clock began, as `performance.now()` answers while installed. */
  elapsed(): number;
  advance(ms: number): void;
  set(epochMs: number): void;
  /** Takes over `Date.now` and `performance.now`; the returned function gives them back. */
  install(): () => void;
}

export function createFixtureClock(start: number = FIXTURE_EPOCH): FixtureClock {
  let time = start;
  const clock: FixtureClock = {
    now: () => time,
    elapsed: () => time - start,
    advance(ms) {
      if (!(ms >= 0)) throw new RangeError(`a fixture clock only moves forward (asked ${ms} ms)`);
      time += ms;
    },
    set(epochMs) {
      time = epochMs;
    },
    install() {
      const dateNow = Date.now;
      const performanceNow = typeof performance === 'undefined' ? undefined : performance.now;
      Date.now = () => clock.now();
      if (performanceNow !== undefined) performance.now = () => clock.elapsed();
      return () => {
        Date.now = dateNow;
        if (performanceNow !== undefined) performance.now = performanceNow;
      };
    },
  };
  return clock;
}
