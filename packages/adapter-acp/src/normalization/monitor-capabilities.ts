import type { ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';

export const ACP_CONTRACT = 'acp@1.2.1';

/**
 * Generic ACP claims stop at the standard protocol boundary. Agent-specific
 * extension methods belong in the composing adapter (for example Grok), not
 * here.
 */
export const ACP_MONITOR_CAPABILITIES: readonly ObservationCapability[] = [
  {
    family: 'status',
    support: 'supported',
    actorScope: 'root',
    latency: 'response',
    source: 'acp-turn-tool-permission-and-elicitation',
    contractVersion: ACP_CONTRACT,
    limitations: [
      'ACP exposes root-session activity and structured permissions.',
      'Structured form and URL elicitations are experimental and require client capability negotiation.',
      'A transport close degrades observation; it never proves that the host process exited.',
    ],
  },
  {
    family: 'usage',
    support: 'unsupported',
    actorScope: 'root',
    latency: 'response',
    source: 'none-in-acp-1.2.1',
    contractVersion: ACP_CONTRACT,
    limitations: [
      'usage_update.used is current context occupancy, not cumulative or per-response token consumption.',
      'ACP 1.2.1 exposes cumulative monetary cost but no token-burn ledger or per-actor usage.',
    ],
  },
  {
    family: 'context',
    support: 'supported',
    actorScope: 'root',
    latency: 'response',
    source: 'acp-usage-update',
    contractVersion: ACP_CONTRACT,
    limitations: ['Context is available when the agent emits the optional usage_update notification.'],
  },
  {
    family: 'model',
    support: 'supported',
    actorScope: 'root',
    latency: 'response',
    source: 'acp-model-config-option',
    contractVersion: ACP_CONTRACT,
    limitations: [
      'The model is available when the agent supplies a config option with the standard model category.',
      'ACP reports current session configuration, not a separate per-request routing boundary.',
    ],
  },
  {
    family: 'effort',
    support: 'supported',
    actorScope: 'root',
    latency: 'response',
    source: 'acp-thought-level-config-option',
    contractVersion: ACP_CONTRACT,
    limitations: [
      'Effort is the current thought_level config value when supplied by the agent.',
      'ACP does not expose a separate per-request applied-effort boundary.',
    ],
  },
  {
    family: 'mode',
    support: 'supported',
    actorScope: 'session',
    latency: 'response',
    source: 'acp-session-mode',
    contractVersion: ACP_CONTRACT,
    limitations: [
      'Provider session mode IDs remain open strings and are not conflated with Puppeteer execution mode.',
      'Permission posture is visible through concrete permission requests, not a standardized ACP permission mode.',
    ],
  },
  {
    family: 'delegation',
    support: 'unsupported',
    actorScope: 'root',
    latency: 'historical',
    source: 'none-in-acp-1.2.1',
    contractVersion: ACP_CONTRACT,
    limitations: ['ACP 1.2.1 defines no subagent identity, parentage, team membership, or child activity stream.'],
  },
  {
    family: 'workflow',
    support: 'unsupported',
    actorScope: 'session',
    latency: 'historical',
    source: 'none-in-acp-1.2.1',
    contractVersion: ACP_CONTRACT,
    limitations: ['ACP 1.2.1 defines no workflow-run identity, membership, or bounded workflow artifact contract.'],
  },
  {
    family: 'compaction',
    support: 'unsupported',
    actorScope: 'session',
    latency: 'historical',
    source: 'none-in-acp-1.2.1',
    contractVersion: ACP_CONTRACT,
    limitations: ['ACP 1.2.1 defines no context-compaction lifecycle notification.'],
  },
  {
    family: 'environment',
    support: 'supported',
    actorScope: 'session',
    latency: 'response',
    source: 'acp-session-setup',
    contractVersion: ACP_CONTRACT,
    limitations: ['ACP session setup proves cwd; Git and worktree topology remain runtime-owned.'],
  },
] as const;
