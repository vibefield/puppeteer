import { createSwarmPhysicsHost } from './host.js';
import { isSwarmFrame, type SwarmPhysicsCommand, type SwarmPhysicsEvent } from './protocol.js';

// THE MAIN THREAD'S END OF THE WIRE, in its simplest home.
//
// A driver is what the swarm view talks to: commands go down, events and
// frames come back. This one runs the SAME host the worker runs, in this
// thread, which is what makes it a legitimate stand-in rather than a second
// implementation that agrees by coincidence. A host that can spin a worker
// (VibeField does) supplies its own driver through `SwarmPhysicsDriverContext`;
// a host that cannot, or a fixture, uses this one.

export interface SwarmPhysicsDriverOptions {
  onEvent(event: SwarmPhysicsEvent): void;
  /** Called with a frame the driver does not own past the call: read it and hand it back. */
  onFrame(frame: Float32Array): void;
}

export interface SwarmPhysicsDriver {
  readonly mode: 'worker' | 'inline';
  post(command: SwarmPhysicsCommand, transfer?: Transferable[]): void;
  dispose(): void;
}

export type SwarmPhysicsDriverFactory = (options: SwarmPhysicsDriverOptions) => SwarmPhysicsDriver;

/** How the inline host gets its pumps. The default rides rAF, so a fixture that
 * drives frames drives the physics with them. */
export type InlinePhysicsSchedule = (pump: (now: number) => void) => () => void;

function scheduleOnAnimationFrame(pump: (now: number) => void): () => void {
  let frame = requestAnimationFrame(function tick(now: number) {
    pump(now);
    frame = requestAnimationFrame(tick);
  });
  return () => cancelAnimationFrame(frame);
}

/**
 * The same physics, in this thread.
 *
 * Frames are delivered SYNCHRONOUSLY from inside the pump, which is what makes a
 * fixture deterministic: drive one animation frame and the simulation has
 * advanced, the frame has been delivered, and the view can be asserted on
 * without a single await.
 */
export function createInlineSwarmPhysicsDriver(
  options: SwarmPhysicsDriverOptions & { schedule?: InlinePhysicsSchedule },
): SwarmPhysicsDriver {
  const host = createSwarmPhysicsHost({
    post: (message) => {
      if (isSwarmFrame(message)) options.onFrame(message);
      else options.onEvent(message);
    },
  });
  const stop = (options.schedule ?? scheduleOnAnimationFrame)((now) => host.pump(now));
  return {
    mode: 'inline',
    post: (command) => host.handle(command),
    dispose: () => {
      stop();
      host.dispose();
    },
  };
}
