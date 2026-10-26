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
      'A subagent child turn (its queue/changed runningPromptId until its turn_completed, forwarded under the child sessionId) is the subagent actor’s activity; other child-session status, such as a child permission request, is not projected.',
      'Without a host approval handler the request is left to the native viewer (presentation native-tui). Grok reports no outcome for a viewer answer, so it is settled from the tool call that follows (in_progress/completed allowed; toolNotRun rejected denied, cancelled dismissed) or the turn cancellation; a request no evidence settles ends unknown at turn end, transport close, or disposal.',
    ],
  },
  {
    family: 'usage',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'grok-response-and-turn-completed-usage',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'Usage requires direct ACP response/turn notifications. Journal records are excluded.',
      'signals.json and subagent progress are context occupancy, never billed burn.',
      'A subagent child’s response and turn usage, forwarded under the child sessionId, is attributed to the actor subagent_spawned names for that child_session_id. Frames a child sends before its subagent_spawned are not projected; its later turn_completed still reconciles the turn total.',
      'Captured live response_completed carries no signature or eventId; a response is identified by its session, the running native prompt (queue/changed runningPromptId or the turn’s _meta.promptId), and its ordinal within that prompt, and turn_completed reconciles the turn total.',
      'A response whose native prompt is unknown, signed or not (the 1.0.0 live shape), is not counted on its own; its turn_completed carries the whole turn total.',
      'A turn total Grok flags usageIsIncomplete is not reconciled; its response contributions stand.',
      'Turns cancelled mid-turn (session/cancel) carry no turn_completed usage; only responses completed before the cancel count.',
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
