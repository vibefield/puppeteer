import { setImmediate } from 'node:timers/promises';

/** Bound synchronous transcript work, including time spent in event listeners. */
export function createTranscriptYield(): () => Promise<void> | undefined {
  let count = 0;
  let startedAt = performance.now();
  return () => {
    if (++count < 128 && performance.now() - startedAt < 8) return undefined;
    count = 0;
    return setImmediate().then(() => {
      startedAt = performance.now();
    });
  };
}
