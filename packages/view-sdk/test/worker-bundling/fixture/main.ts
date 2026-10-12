import { createWorkerDriver } from '../../../src/toolkit/worker.js';
import { createInlineEcho, type EchoCommand, type EchoMessage } from './inline-echo.js';

// THE FIXTURE "VIEW". It names its worker exactly as a view in packages/views
// would, relative to its own module, and publishes where its echo ran as
// `globalThis.__result` for the harness. `__workerUrl` stands for a URL a host
// provides (the IIFE lab's blob); every other variant leaves it unset.
//
// The constructor is written LITERALLY — `new Worker(new URL('…',
// import.meta.url), { static options })` — because that exact shape is what
// Vite recognises and bundles; a URL computed any other way is invisible to it.
// The host-provided URL is therefore its own branch, never an operand inside
// the literal form.

const globals = globalThis as unknown as { __result?: unknown; __workerUrl?: string };
let demoted = '';
const driver = createWorkerDriver<EchoCommand, EchoMessage>({
  createWorker: () =>
    globals.__workerUrl === undefined
      ? new Worker(new URL('./echo.worker.js', import.meta.url), { type: 'module', name: 'view-sdk-echo' })
      : new Worker(globals.__workerUrl, { type: 'module', name: 'view-sdk-echo' }),
  createInline: createInlineEcho,
  onMessage: (message) => {
    globals.__result = { mode: driver.mode, where: message.where, demoted };
  },
  replayKey: (command) => command.type,
  readyTimeoutMs: 1500,
  onDemote: (reason) => {
    demoted = reason;
  },
});
driver.post({ type: 'ping' });
