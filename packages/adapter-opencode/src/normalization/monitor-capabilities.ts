import type { ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';

export const OPENCODE_CONTRACT = 'opencode@1.18.16:http-sse';

/**
 * Claims are bounded by the pinned 1.18.16 Surface captures. Generated-only
 * todo shapes stay degraded, and provider model variants are not asserted to
 * be literal reasoning effort for every custom model configuration.
 */
export const OPENCODE_MONITOR_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'status',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'opencode-session-message-tool-blocker-sse',
    contractVersion: OPENCODE_CONTRACT,
    limitations: [
      'The workspace SSE stream and durable REST reconciliation cover the root and known child sessions.',
      'A disconnected SSE rail degrades observation; it never proves that the attached TUI process exited.',
    ],
  },
  {
    family: 'usage',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'opencode-completed-assistant-token-usage',
    contractVersion: OPENCODE_CONTRACT,
    limitations: [
      'Canonical burn is emitted at native step/assistant response boundaries, not estimated from context occupancy.',
      'Child usage is available after native parent/child identity is established; OpenCode exposes no agent-team aggregate.',
    ],
  },
  {
    family: 'context',
    support: 'degraded',
    actorScope: 'root',
    latency: 'response',
    source: 'opencode-step-finish-tokens-plus-verified-capacity',
    contractVersion: OPENCODE_CONTRACT,
    limitations: [
      'Current request token pressure is exact, but percentage requires a separately verified positive model capacity.',
      'The adapter does not apply the root capacity to child models that may differ.',
    ],
  },
  {
    family: 'model',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'opencode-session-and-message-model-fields',
    contractVersion: OPENCODE_CONTRACT,
    limitations: ['Applied model changes are observed per native message; configured intent remains a separate claim.'],
  },
  {
    family: 'effort',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'opencode-model-variant',
    contractVersion: OPENCODE_CONTRACT,
    limitations: [
      'OpenCode variants commonly select reasoning effort or thinking budgets, but custom variants may contain unrelated request overlays.',
      'The raw applied variant is reported without pretending its name is a provider-neutral effort scale.',
    ],
  },
  {
    family: 'mode',
    support: 'supported',
    actorScope: 'session',
    latency: 'response',
    source: 'opencode-session-agent-and-assistant-mode',
    contractVersion: OPENCODE_CONTRACT,
    limitations: [
      'Provider modes such as build, plan, explore, and compaction remain provider-native strings.',
      'Configured permission policy is not collapsed into a misleading Auto/Manual label.',
    ],
  },
  {
    family: 'planning',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'opencode-todo-updated',
    contractVersion: OPENCODE_CONTRACT,
    limitations: [
      'todo.updated is generated-schema-backed but has no pinned runtime capture in 1.18.16.',
      'Todo snapshots have statuses but no stable native todo IDs, so they are plans rather than independently identified task lifecycles.',
      'The verified reconciliation recipe has no captured durable todo endpoint response, so an SSE gap can lose a plan revision.',
    ],
  },
  {
    family: 'delegation',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'opencode-child-session-lifecycle-and-history',
    contractVersion: OPENCODE_CONTRACT,
    limitations: [
      'Stable child session IDs, parentage, state, model, and response usage are observable.',
      'No verified agent-team identity or membership surface exists, so team creation and team-member aggregation remain unavailable.',
    ],
  },
  {
    family: 'workflow',
    support: 'unsupported',
    actorScope: 'session',
    latency: 'historical',
    source: 'none-in-opencode-1.18.16-census',
    contractVersion: OPENCODE_CONTRACT,
    limitations: [
      'No verified workflow-run identity, workflow membership, or bounded workflow artifact contract exists.',
    ],
  },
  {
    family: 'compaction',
    support: 'supported',
    actorScope: 'session',
    latency: 'response',
    source: 'opencode-compaction-part-and-session-compacted',
    contractVersion: OPENCODE_CONTRACT,
    limitations: [
      'Manual, threshold, and overflow triggers are visible; completed compaction invalidates prior context pressure.',
    ],
  },
  {
    family: 'environment',
    support: 'supported',
    actorScope: 'session',
    latency: 'response',
    source: 'opencode-session-directory',
    contractVersion: OPENCODE_CONTRACT,
    limitations: ['The provider proves cwd; Git and worktree topology remain runtime-owned.'],
  },
] as const;
