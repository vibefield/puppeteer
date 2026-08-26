/**
 * @vibecook/puppeteer-core — contracts for the puppeteer agent runtime.
 *
 * Zero I/O by design (DESIGN §8, acceptance criterion 19): types, the session
 * state reducer, and pure helpers only. Anything touching a PTY, process,
 * socket, or file lives in an adapter, runtime, or host application package.
 */

export * from './events.js';
export * from './adapter/event-candidate.js';
export * from './state.js';
export * from './session.js';
export * from './services/index.js';
export * from './host.js';
export * from './account-usage.js';
export * from './monitor/index.js';
export * from './version.js';
