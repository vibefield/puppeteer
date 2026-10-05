import { createWorkerDriver, type WorkerDriverMode } from '@vibecook/puppeteer-view-sdk/toolkit';
import { createSwarmPhysicsHost, type SwarmPhysicsHost } from './host.js';
import {
  isSwarmFrame,
  type SwarmPhysicsCommand,
  type SwarmPhysicsEvent,
  type SwarmPhysicsOutbound,
} from './protocol.js';

// THE VIEW'S OWN DRIVER (MV-D7): the swarm owns its physics worker, through the
// SDK's helper, so every host gets the same three guarantees — proof of life,
// demotion with replay, an honest mode — without supplying a thread of its own.
//
// The worker is named the one way every host's bundler finds it (the toolkit's
// README, "Workers and bundlers"): Vite resolves the literal `new URL` and emits
// a same-origin chunk; puppeteer's Godview (esbuild ESM) builds the entry beside
// its chunks (apps/godview/build.mjs); a single-file IIFE lab has no
// `import.meta.url`, the constructor throws, and the SAME host runs in this
// thread from the start. Where it runs is reported, never assumed.
//
// Inline, the host is pumped by the view's own frame loop (`pump`), in the frame
// it is drawn in, as the inline driver's animation frame did before: no second
// loop, and nothing runs while the view is told to hold still.

/**
 * The commands whose latest post stands for the world a demotion replays: a key
 * for each kind. Gestures and queries are not replayed, and a returned buffer
 * belongs to the thread it went to.
 */
const REPLAYED: Readonly<Partial<Record<SwarmPhysicsCommand['type'], string>>> = {
  init: 'init',
  updateAgents: 'agents',
  updateParameters: 'parameters',
  updateBounds: 'bounds',
  updateObstacles: 'obstacles',
  pause: 'motion',
  resume: 'motion',
};

export interface SwarmPhysicsDriverOptions {
  onEvent(event: SwarmPhysicsEvent): void;
  /** Called with a frame the driver does not own past the call: read it and hand it back (`releaseFrame`). */
  onFrame(frame: Float32Array): void;
  /** The simulation runs in this thread instead: why (for a log, never a toast). */
  onDemote?(reason: string): void;
  /** A worker that had proved itself died. */
  onError?(detail: string, error: unknown): void;
}

export interface SwarmPhysicsDriver {
  /** Where the simulation runs now; a demotion changes it. */
  readonly mode: WorkerDriverMode;
  post(command: SwarmPhysicsCommand, transfer?: Transferable[]): void;
  /** Advances a simulation that runs in this thread; nothing for one in a worker, which keeps its own clock. */
  pump(now: number): void;
  /** Calls `listener` with the mode now and at every change; returns the stop. */
  observeMode(listener: (mode: WorkerDriverMode) => void): () => void;
  dispose(): void;
}

export function createSwarmPhysicsDriver(options: SwarmPhysicsDriverOptions): SwarmPhysicsDriver {
  let inline: SwarmPhysicsHost | undefined;
  const driver = createWorkerDriver<SwarmPhysicsCommand, SwarmPhysicsOutbound>({
    createWorker: () =>
      new Worker(new URL('./swarm-physics.worker.js', import.meta.url), { type: 'module', name: 'swarm-physics' }),
    createInline: (deliver) => {
      // The same host the worker runs, in this thread: a legitimate stand-in, not a second implementation.
      const host = createSwarmPhysicsHost({ post: (message) => deliver(message) });
      inline = host;
      return {
        post: (command) => host.handle(command),
        dispose: () => {
          host.dispose();
          inline = undefined;
        },
      };
    },
    onMessage: (message) => {
      if (isSwarmFrame(message)) options.onFrame(message);
      else options.onEvent(message);
    },
    replayKey: (command) => REPLAYED[command.type],
    ...(options.onDemote ? { onDemote: options.onDemote } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });
  return {
    get mode() {
      return driver.mode;
    },
    post: (command, transfer) => driver.post(command, transfer),
    pump: (now) => inline?.pump(now),
    observeMode: (listener) => driver.observeMode(listener),
    dispose: () => driver.dispose(),
  };
}
