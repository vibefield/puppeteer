import type { ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';

export const HERMES_CONTRACT = 'hermes@0.20.0:tui-gateway';

/**
 * Runtime-verified claims come from the pinned 0.20.0 captures. Claims for
 * context, clarification, compaction, and subagents are deliberately
 * degraded because only the exact release source establishes those branches.
 */
export const HERMES_MONITOR_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'status',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'hermes-gateway-message-tool-and-blocker-events',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'Root turn, tool, and approval activity is runtime verified.',
      'Structured clarify choices and subagent activity are exact-release-source-backed but not pinned-runtime captured.',
      'Loss of the gateway rail degrades observation and never proves that the attached native TUI exited.',
    ],
  },
  {
    family: 'usage',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'sample',
    source: 'hermes-session-usage-and-subagent-completion-rollups',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'Root burn rate is derived from cumulative gateway samples at response/session-info boundaries, not token streaming.',
      'Subagent totals arrive only on subagent.complete, so a live per-subagent burn rate is usually unavailable.',
      'Root samples are session aggregates; per-child samples are kept out of the root aggregate timeline.',
    ],
  },
  {
    family: 'context',
    support: 'degraded',
    actorScope: 'root',
    latency: 'response',
    source: 'hermes-usage-context-used-max-percent',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'Current occupancy and capacity are emitted only after the context engine has a real prompt measurement.',
      'The fields are exact-release-source-backed but were absent from the pinned fake-provider runtime captures.',
      'Hermes 0.20.0 refreshes the gateway gauge at response boundaries rather than continuously during a turn.',
    ],
  },
  {
    family: 'model',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'hermes-session-info-and-subagent-events',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'Root model changes are reported by session.info; subagent models are exact-release-source-backed.',
      'A model switch queued during a turn is the next-turn selection until Hermes applies it.',
    ],
  },
  {
    family: 'effort',
    support: 'degraded',
    actorScope: 'root',
    latency: 'response',
    source: 'hermes-session-info-reasoning-effort',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'The current reasoning_effort field and its update events are exact-release-source-backed but not retained in sanitized runtime captures.',
      'An empty native value means provider default rather than a concrete reasoning level.',
      'No per-subagent effort field is exposed.',
    ],
  },
  {
    family: 'mode',
    support: 'supported',
    actorScope: 'session',
    latency: 'response',
    source: 'hermes-session-info-effective-approval-mode',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'Hermes exposes effective manual/off/YOLO approval posture, not Claude-style Plan or Accept Edit modes.',
      'YOLO and approvals.mode=off normalize to auto while the provider-native value remains visible.',
    ],
  },
  {
    family: 'delegation',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'hermes-subagent-events',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'Stable subagent and child-session identity, parentage, activity, model, and completion totals exist in the exact release source.',
      'The subagent event family was not exercised by the pinned runtime census.',
    ],
  },
  {
    family: 'compaction',
    support: 'degraded',
    actorScope: 'session',
    latency: 'response',
    source: 'hermes-compacting-status-and-compression-counter',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'Exact release source emits compacting status and a cumulative compression count, but the pinned runtime census did not exercise it.',
      'A missed start cannot be reconstructed as an exact lifecycle from the later counter alone.',
    ],
  },
  {
    family: 'environment',
    support: 'supported',
    actorScope: 'session',
    latency: 'response',
    source: 'hermes-session-info-cwd',
    contractVersion: HERMES_CONTRACT,
    limitations: ['The gateway proves cwd; Git/worktree topology remains runtime-owned.'],
  },
] as const;
