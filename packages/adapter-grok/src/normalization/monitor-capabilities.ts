import type { ObservationCapability } from '@vibefield/puppeteer-core/monitor-spi';

export const GROK_CONTRACT = 'grok-native@1.0.70+acp@1.2.1';

/**
 * Claims follow the pinned Grok 1.0.70 Surface (a binary-only census: no
 * public source exists for this release), not the locally installed binary.
 * Mirror- or binary-string-only shapes are parsed opportunistically but stay
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
      'Without a host approval handler the request is left to the native viewer (presentation native-tui). Grok reports no outcome for a viewer answer, so it is settled from the tool call that follows (in_progress/completed allowed; toolNotRun rejected denied, cancelled dismissed) or the turn cancellation; a request no evidence settles ends unknown at turn end, transport close, or disposal.',
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
      'Captured live response_completed carries no signature or eventId, so per-response usage is not attributed; turn_completed reconciles the turn total.',
      'Turns cancelled mid-turn (session/cancel) carry no turn_completed usage.',
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
      'Before signals.json exists, context capacity requires the selected model in the native model cache (models_cache.json is unverified on the pinned artifact).',
      'signals.json is written asynchronously after the prompt result, so a context sample can trail turn completion.',
    ],
  },
  {
    family: 'model',
    support: 'supported',
    actorScope: 'root',
    latency: 'file-flush',
    source: 'grok-summary-json-and-acp-config',
    contractVersion: GROK_CONTRACT,
    limitations: ['Live model_changed carries model_id only; subagent model fields are verified on the spawn record.'],
  },
  {
    family: 'effort',
    support: 'degraded',
    actorScope: 'root',
    latency: 'response',
    source: 'grok-model-changed-extension',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'reasoning_effort exists in mirror source but not in the pinned 1.0.70 census; model_changed carried model_id only.',
    ],
  },
  {
    family: 'mode',
    support: 'degraded',
    actorScope: 'session',
    latency: 'response',
    source: 'grok-argv-and-acp-current-mode',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'Configured permission/sandbox posture is intent; current ACP mode updates were not captured at 1.0.70.',
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
      'Subagent spawn/finish are runtime-verified; subagent_progress remains mirror-source only.',
      'Child tool calls were not observed on the parent connection.',
    ],
  },
  {
    family: 'compaction',
    support: 'degraded',
    actorScope: 'session',
    latency: 'response',
    source: 'grok-auto-compact-and-signals',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'auto_compact_completed and compaction_checkpoint are runtime-verified; started/failed/cancelled phases remain mirror-source only.',
    ],
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
