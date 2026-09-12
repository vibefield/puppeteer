import type { ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';

export const KIMI_CONTRACT = 'kimi-wire@1.5+surface@0.34.0';

/** Claims are bounded by the pinned 0.34.0 Surface and its exact release source. */
export const KIMI_MONITOR_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'status',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'kimi-wire-journals',
    contractVersion: KIMI_CONTRACT,
    limitations: ['Structured question choices are exact-source-backed but not pinned-runtime verified.'],
  },
  {
    family: 'usage',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'kimi-usage-record',
    contractVersion: KIMI_CONTRACT,
    limitations: [
      'Usage arrives at response boundaries rather than token-stream boundaries.',
      'A resumed journal larger than the bounded replay window reports partial historical coverage.',
    ],
  },
  {
    family: 'context',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'kimi-usage-record',
    contractVersion: KIMI_CONTRACT,
    limitations: [
      'Request input occupancy is exact, but the durable wire exposes no context capacity.',
      'llm.request.maxTokens is a completion limit and is never treated as context capacity.',
      'Real-time context-window percentage is unavailable.',
    ],
  },
  {
    family: 'model',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'kimi-profile-bind-and-llm-request',
    contractVersion: KIMI_CONTRACT,
    limitations: ['profile.bind is configured alias evidence; llm.request is the applied provider model.'],
  },
  {
    family: 'effort',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'kimi-profile-bind-and-llm-request',
    contractVersion: KIMI_CONTRACT,
    limitations: ['Applied changes become visible at the next llm.request boundary.'],
  },
  {
    family: 'mode',
    support: 'degraded',
    actorScope: 'session',
    latency: 'file-flush',
    source: 'kimi-permission-and-plan-mode-records',
    contractVersion: KIMI_CONTRACT,
    limitations: [
      'manual, yolo, and auto permission modes are runtime verified.',
      'Plan-mode transitions are exact-source-backed but not pinned-runtime verified.',
      'Kimi has no verified Accept Edit mode equivalent.',
    ],
  },
  {
    family: 'delegation',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'file-flush',
    source: 'kimi-child-wire-journals',
    contractVersion: KIMI_CONTRACT,
    limitations: [
      'Child journal presence, activity, model, effort, context input, and usage are observable.',
      'A universal child-stop record and stable team membership identity are not verified.',
    ],
  },
  {
    family: 'workflow',
    support: 'unsupported',
    actorScope: 'session',
    latency: 'historical',
    source: 'kimi-wire-journals',
    contractVersion: KIMI_CONTRACT,
    limitations: [
      'No verified workflow-run identity or bounded workflow-definition artifact exists.',
      'Goals, cron tasks, plans, and swarm mode are not reclassified as workflows.',
    ],
  },
  {
    family: 'compaction',
    support: 'degraded',
    actorScope: 'session',
    latency: 'file-flush',
    source: 'kimi-full-compaction-records',
    contractVersion: KIMI_CONTRACT,
    limitations: ['Compaction lifecycle is exact-source-backed but not pinned-runtime verified.'],
  },
  {
    family: 'environment',
    support: 'supported',
    actorScope: 'session',
    latency: 'file-flush',
    source: 'kimi-profile-bind',
    contractVersion: KIMI_CONTRACT,
    limitations: ['Git and worktree topology remain runtime-owned.'],
  },
] as const;
