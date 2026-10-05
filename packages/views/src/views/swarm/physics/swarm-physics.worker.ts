import { serveWorker } from '@vibecook/puppeteer-view-sdk/toolkit';
import { createSwarmPhysicsHost } from './host.js';
import type { SwarmPhysicsCommand } from './protocol.js';

// THE SWARM'S PHYSICS THREAD (MV-D7; the shape is VibeField's GT-3c worker,
// moved into the view that owns it).
//
// Thin on purpose: this file is a timer and a mailbox. Everything it does is in
// `host.ts`, which the inline fall-back runs too, so there is no behaviour that
// exists only in the worker and therefore only in production.
//
// There is no rAF here: a dedicated worker has none, and does not want one. It
// steps on a timer and the accumulator absorbs the timer's jitter, which is the
// same guard that already absorbed a stalled display.

const scope = globalThis as unknown as { close(): void };

/**
 * Wake this many times per physics step.
 *
 * At 1× a late timer tick — and timers are only ever late — pushes the
 * accumulator either side of the step boundary, so pumps alternate between
 * solving nothing and solving two, and frames reach the main thread in clumps
 * its interpolation then has to smooth over. Sampling at twice the rate catches
 * each boundary within half a step for a wakeup that costs two comparisons when
 * nothing is due.
 */
const OVERSAMPLE = 2;
/** Never spin faster than this, whatever the rate knob says. */
const MIN_TIMER_MS = 4;

let timer: ReturnType<typeof setInterval> | undefined;
let timerPeriod = 0;

const host = createSwarmPhysicsHost({
  post: (message, transfer) => end.post(message, transfer),
});

function retimeIfNeeded(): void {
  if (host.disposed) return;
  const period = Math.max(MIN_TIMER_MS, host.stepMs() / OVERSAMPLE);
  if (timer !== undefined && Math.abs(period - timerPeriod) < 0.5) return;
  if (timer !== undefined) clearInterval(timer);
  timerPeriod = period;
  timer = setInterval(() => host.pump(performance.now()), period);
}

function stop(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

// PROOF OF LIFE, first thing after the imports: everything above has been
// evaluated — matter included — so the `ready` the toolkit posts means this
// thread can actually simulate. The driver's watchdog waits for exactly this; a
// load that fails never reaches this statement, and the swarm runs inline under
// a marker that says so.
const end = serveWorker<SwarmPhysicsCommand>((command) => {
  host.handle(command);
  if (command.type === 'dispose') {
    stop();
    // The stage is gone: this thread has nothing left to be. Closing is belt to
    // the terminate()'s braces — whichever lands first, no swarm physics
    // outlives the swarm.
    scope.close();
    return;
  }
  if (command.type === 'init' || command.type === 'updateParameters') retimeIfNeeded();
});
