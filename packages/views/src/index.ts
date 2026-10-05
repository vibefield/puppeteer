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
// The marks are the SDK's (M6): AgentIcon and ProfileGlyph are `@vibecook/puppeteer-view-sdk/react`'s and the
// shapes `/toolkit`'s. This index forwards none of them (M54, MV-8): a host imports them from the SDK.
export * from './icons/profile-glyph-suggest.js';
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
export * from './views/swarm/gpu/swarm-renderer.js';
// The lab's fixture rows: every drawn state, for a host's own catalog.
export * from './views/swarm/lab/fixtures.js';
export * from './views/swarm/physics/index.js';
export * from './views/list/index.js';
export * from './views/list/list-parameters.js';
// The list's two-step menu under ＋ TERMINAL (SB-D11), for a host's catalog.
export * from './views/list/ListSpawnMenu.js';
export * from './views/rain/index.js';
export * from './views/rain/rain-parameters.js';
export * from './views/rain/rain-streams.js';
export * from './views/timeline/index.js';
export * from './views/timeline/timeline-parameters.js';
export * from './views/timeline/timeline-lanes.js';
export * from './views/timeline/timeline-scale.js';
export * from './views/timeline/timeline-words.js';
export * from './views/timeline/wake-geometry.js';
export * from './views/timeline/pulse-map.js';
export { TimelineView } from './views/timeline/TimelineView.js';
// The timeline's example afternoon, for a host's catalog to mount the shipping view with.
export * from './views/timeline/lab/timeline-fixtures.js';
// The seeded world every lab and golden draws (MV-0): n rows over every state, at a fixed clock.
export * from './lab/lab-world.js';
// The deck's pane frame (record §07) behind a verbs port — PU-14.
export * from './deck/index.js';
