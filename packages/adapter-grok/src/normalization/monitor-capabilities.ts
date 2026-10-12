import type { ObservationCapability } from '@vibefield/puppeteer-core/monitor-spi';

export const GROK_CONTRACT = 'grok-native@1.0.0+acp@1.2.1';

/**
 * Claims follow the pinned Grok 1.0.0 Surface, not the locally installed
 * binary. Newer official source shapes are parsed opportunistically but stay
 * degraded until a matching runtime capture promotes them.
 */
export const GROK_MONITOR_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'status',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'grok-session-log-and-acp',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'Root turn activity is captured; structured ACP permissions require the control rail.',
      'Native-TUI choice details are not verified on the pinned artifact.',
    ],
  },
  {
    family: 'usage',
    support: 'degraded',
    actorScope: 'root',
    latency: 'response',
    source: 'grok-response-and-turn-completed-usage',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'Usage requires direct ACP response/turn notifications. Journal records are excluded.',
      'signals.json and subagent progress are context occupancy, never billed burn.',
      'No verified per-subagent billed usage surface exists on the pinned artifact.',
    ],
  },
  {
    family: 'context',
    support: 'supported',
    actorScope: 'root',
    latency: 'sample',
    source: 'grok-update-metadata-model-cache-signals-json-and-acp-usage-update',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'Before signals.json exists, context capacity requires the selected model in the native model cache.',
    ],
  },
  {
    family: 'model',
    support: 'supported',
    actorScope: 'root',
    latency: 'file-flush',
    source: 'grok-summary-json-and-acp-config',
    contractVersion: GROK_CONTRACT,
    limitations: ['Live model_changed and child model fields are source-backed but not pinned-runtime verified.'],
  },
  {
    family: 'effort',
    support: 'degraded',
    actorScope: 'root',
    latency: 'response',
    source: 'grok-model-changed-extension',
    contractVersion: GROK_CONTRACT,
    limitations: ['reasoning_effort exists in newer official source but not the pinned 1.0.0 census.'],
  },
  {
    family: 'mode',
    support: 'degraded',
    actorScope: 'session',
    latency: 'response',
    source: 'grok-argv-and-acp-current-mode',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'Configured permission/sandbox posture is intent; current ACP mode updates were not captured at 1.0.0.',
    ],
  },
  {
    family: 'delegation',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'grok-subagent-lifecycle',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'Subagent lifecycle is official-source-backed but not pinned-runtime verified.',
      'Child tool calls are not streamed on the parent connection.',
    ],
  },
  {
    family: 'compaction',
    support: 'degraded',
    actorScope: 'session',
    latency: 'response',
    source: 'grok-auto-compact-and-signals',
    contractVersion: GROK_CONTRACT,
    limitations: ['signals.json verifies a compaction counter; phase notifications remain source-backed only.'],
  },
  {
    family: 'environment',
    support: 'supported',
    actorScope: 'session',
    latency: 'file-flush',
    source: 'grok-summary-json-and-acp',
    contractVersion: GROK_CONTRACT,
    limitations: ['Git/worktree topology remains runtime-owned.'],
  },
] as const;
