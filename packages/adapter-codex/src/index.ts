/**
 * @vibecook/puppeteer-adapter-codex — Codex native adapter.
 *
 * Codex's native surface is a structured JSON-RPC `app-server` protocol (M5;
 * packages/surface/vendors/codex/findings.md), so this adapter is a structured driver, not
 * a PTY+transcript clone of the Claude adapter. C2 ships the notification
 * normalizer; the driver, detection, and structured injection follow (C3–C4).
 */

export * from './normalization/index.js';
export * from './detection.js';
export * from './observation/rollout-context.js';
export * from './transport/app-server-client.js';
export * from './transport/app-server-process.js';
export * from './services/account-usage.js';
export * from './services/distribution.js';
export * from './services/extensions.js';
export * from './services/profiles.js';
export * from './services/prewarm.js';
export * from './transport/ws-transport.js';
export * from './driver.js';
export * from './observation/observer.js';
export * from './launch/tui-session.js';
export * from './launch/native-invocation.js';
export * from './services/models.js';
