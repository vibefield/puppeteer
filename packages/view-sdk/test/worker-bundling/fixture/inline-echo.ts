import type { InlineEnd } from '../../../src/toolkit/worker.js';

// The fixture's "simulation": it answers each command with where it ran.

export type EchoCommand = { readonly type: 'ping' };
export type EchoMessage = { readonly type: 'echo'; readonly of: string; readonly where: 'worker' | 'window' };

export function whereAmI(): 'worker' | 'window' {
  return typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'function' ? 'worker' : 'window';
}

/** The same simulation in this thread, for a driver that was demoted or never had a worker. */
export function createInlineEcho(deliver: (message: EchoMessage) => void): InlineEnd<EchoCommand> {
  return {
    post: (command) => deliver({ type: 'echo', of: command.type, where: whereAmI() }),
    dispose: () => {},
  };
}
