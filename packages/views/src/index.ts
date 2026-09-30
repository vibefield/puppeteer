// @vibecook/puppeteer-views — Godview's monitor views as a package (VibeField's
// AR-5, PU-5). Every view is a pure function of `MonitorAgent[]`, the
// parameters and the palette; every fact that needs a process comes through a
// port the host injects (`HistoryPort`, `AccountUsagePort`, `UsageHistoryStore`,
// the swarm's physics driver). Nothing here dials a daemon, reads a file or
// names a provider except as data.
//
// Consumers of the EMITTED declarations: the swarm's renderer types name WebGPU's
// globals (`GPUDevice`, `GPUTexture`, `GPUDeviceLostInfo`), so `@webgpu/types` is a
// dependency — and since tsc does not carry a reference directive into a `.d.ts`,
// a consumer typechecking against `dist` names it in its own tsconfig `types`
// (or checks with `skipLibCheck`). A consumer compiling the source needs nothing.
export * from './monitor/types.js';
export * from './monitor/agent-status.js';
export * from './monitor/agents.js';
export * from './monitor/parameters.js';
export * from './monitor/registry.js';
export * from './monitor/chrome.js';
export * from './monitor/palette.js';
export * from './monitor/unread.js';
export * from './monitor/recede.js';
export * from './monitor/usage-ledger.js';
export * from './monitor/cost-format.js';
export * from './monitor/usage-history.js';
export * from './monitor/remote-write.js';
export * from './monitor/folder-name.js';
export * from './colour/project-tint.js';
export * from './colour/pane-colours.js';
export * from './icons/AgentIcon.js';
export * from './icons/ProfileGlyph.js';
export * from './icons/ServiceMark.js';
export * from './bar/InstrumentBar.js';
export * from './bar/ProfileTabs.js';
export * from './usage/UsageColumn.js';
export * from './usage/account-usage.js';
export * from './usage/account-usage-port.js';
export * from './find/history-port.js';
export * from './find/find-model.js';
export * from './find/FindSheet.js';
export * from './views/swarm/index.js';
export { AgentSwarm } from './views/swarm/AgentSwarm.js';
export * from './views/swarm/bubble-model.js';
export * from './views/swarm/swarm-parameters.js';
export * from './views/swarm/swarm-theme.js';
export * from './views/swarm/text-layout.js';
// The spawn bloom's pure logic (SB): geometry, menu, targeting, words, machine.
export * from './views/swarm/bloom/index.js';
// …and its overlay (the DOM over the field), which a host's catalog may mount posed.
export * from './views/swarm/bloom/SpawnBloom.js';
export * from './views/swarm/bloom/canvas-measure.js';
export * from './views/swarm/gpu/color.js';
export * from './views/swarm/gpu/swarm-renderer.js';
// The lab's fixture rows: every drawn state, for a host's own catalog.
export * from './views/swarm/lab/fixtures.js';
export * from './views/swarm/physics/index.js';
// The React provider is the MAIN entry's on purpose: the physics subpath is a
// worker's import and carries no React (4d734c9).
export * from './views/swarm/physics/context.js';
export * from './views/list/index.js';
export * from './views/list/list-parameters.js';
export * from './views/rain/index.js';
export * from './views/rain/rain-parameters.js';
export * from './views/rain/rain-streams.js';
// The deck's pane frame (record §07) behind a verbs port — PU-14.
export * from './deck/index.js';
