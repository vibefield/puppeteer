import type { ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';

export const CODEX_CONTRACT = 'codex-app-server@0.150.0';

/**
 * Capability claims are deliberately narrower than the generated schema.
 * Runtime captures prove root usage/context and the base lifecycle. Settings,
 * plans, compaction items, and collaboration items have exact vendor-declared
 * shapes but no pinned runtime fixture, so those families remain degraded.
 */
export const CODEX_MONITOR_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'status',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'codex-app-server',
    contractVersion: CODEX_CONTRACT,
    limitations: [
      'The controller observes structured approvals; native-TUI user-input requests may remain on the TUI connection.',
    ],
  },
  {
    family: 'usage',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'sample',
    source: 'codex-thread-token-usage',
    contractVersion: CODEX_CONTRACT,
    limitations: [
      'Pinned captures prove total is cumulative and last is per-response context pressure.',
      "Per-child usage requires the app-server connection to receive that child thread's notifications.",
    ],
  },
  {
    family: 'context',
    support: 'supported',
    actorScope: 'root',
    latency: 'sample',
    source: 'codex-thread-token-usage-and-rollout-tail',
    contractVersion: CODEX_CONTRACT,
    limitations: ['Only root context is projected; child occupancy stays in native evidence.'],
  },
  {
    family: 'model',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'codex-thread-response-settings-and-reroute',
    contractVersion: CODEX_CONTRACT,
    limitations: ['Per-child model requires child-thread settings or a collaboration spawn item.'],
  },
  {
    family: 'effort',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'codex-thread-response-and-settings',
    contractVersion: CODEX_CONTRACT,
    limitations: ['Mid-session settings shape is vendor-schema-backed but not present in the pinned runtime census.'],
  },
  {
    family: 'mode',
    support: 'degraded',
    actorScope: 'session',
    latency: 'response',
    source: 'codex-thread-response-and-settings',
    contractVersion: CODEX_CONTRACT,
    limitations: [
      'Plan/default collaboration mode requires thread/settings/updated.',
      'Approval and sandbox values are preserved together as provider permission state.',
    ],
  },
  {
    family: 'delegation',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'codex-collaboration-thread-items',
    contractVersion: CODEX_CONTRACT,
    limitations: ['Child thread/item shapes are vendor-schema-backed but not present in the pinned runtime census.'],
  },
  {
    family: 'compaction',
    support: 'degraded',
    actorScope: 'session',
    latency: 'response',
    source: 'codex-context-compaction-item',
    contractVersion: CODEX_CONTRACT,
    limitations: ['The item lifecycle is vendor-schema-backed but absent from the pinned runtime census.'],
  },
  {
    family: 'environment',
    support: 'supported',
    actorScope: 'session',
    latency: 'response',
    source: 'codex-thread-response-and-settings',
    contractVersion: CODEX_CONTRACT,
    limitations: ['Git/worktree topology remains runtime-owned.'],
  },
] as const;
