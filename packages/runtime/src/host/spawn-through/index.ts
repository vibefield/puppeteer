/**
 * `@vibecook/puppeteer-runtime/spawn-through` — the host kit that turns a
 * command typed in a host's terminal into a managed session
 * (docs/guides/spawn-through-hosts.md). The shim itself is the separate
 * `./spawn-through/shim` entry: hosts bundle it, and importing it runs it.
 */
export * from './protocol.js';
export * from './gateway.js';
export * from './prepare.js';
export * from './rendezvous.js';
export * from './layout.js';
export * from './materialize.js';
export * from './shell-integration.js';
export * from './process-watch.js';
export * from './terminals.js';
