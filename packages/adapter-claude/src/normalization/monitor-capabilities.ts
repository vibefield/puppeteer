import type { ObservationCapability } from '@vibecook/puppeteer-core/monitor-spi';

const CLAUDE_MONITOR_CAPABILITY_BASE: readonly ObservationCapability[] = [
  {
    family: 'status',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'hook',
    source: 'claude-hooks',
    limitations: ['Child lifecycle depends on hook attribution and visible task evidence.'],
  },
  {
    family: 'usage',
    support: 'supported',
    actorScope: 'current-actors',
    latency: 'response',
    source: 'claude-otlp-logs',
    contractVersion: 'claude-code-api-request@1',
    limitations: [
      'Settled requests are exact; Claude exposes no sanctioned intra-response token delta.',
      'Request totals cover observed API completions; historical transcript usage is not imported.',
      'Per-child attribution is present only when Claude emits a native agent id.',
      'Child context occupancy and untimed status samples are not token consumption; usage comes only from OTLP requests.',
    ],
  },
  {
    family: 'context',
    support: 'degraded',
    actorScope: 'root',
    latency: 'sample',
    source: 'claude-status-channels',
    limitations: ['Root context is provider-calculated; child context stays in native evidence.'],
  },
  {
    family: 'model',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'sample',
    source: 'claude-hooks-status-and-otlp',
    limitations: [
      'Models depend on session hooks, visible status tasks or observed API requests; historical models are not imported.',
      'Per-child models require native actor identity; otherwise OTLP retains a derived actor group.',
    ],
  },
  {
    family: 'effort',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'sample',
    source: 'claude-hooks-and-status',
    limitations: ['Child status exposes configured effort, not necessarily the applied value.'],
  },
  {
    family: 'mode',
    support: 'supported',
    actorScope: 'session',
    latency: 'hook',
    source: 'claude-hooks',
    limitations: ['Provider permission/session modes remain separate open strings.'],
  },
  {
    family: 'delegation',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'hook',
    source: 'claude-hooks-and-child-status',
    limitations: ['Task-row IDs are not merged with hook agent IDs without verified equality.'],
  },
  {
    family: 'compaction',
    support: 'supported',
    actorScope: 'session',
    latency: 'hook',
    source: 'claude-hooks',
    limitations: ['PreCompact is provisional until PostCompact.'],
  },
  {
    family: 'environment',
    support: 'supported',
    actorScope: 'session',
    latency: 'sample',
    source: 'claude-hooks-status-and-workspace',
    limitations: ['Git/worktree topology remains runtime-owned.'],
  },
] as const;

export function claudeMonitorCapabilities(
  otelUsageEnabled: boolean,
  unavailableReason = 'Authenticated OTLP request logs are unavailable for this session.',
  otelUsageVerified = otelUsageEnabled,
): readonly ObservationCapability[] {
  if (otelUsageEnabled && otelUsageVerified) return CLAUDE_MONITOR_CAPABILITY_BASE;
  return CLAUDE_MONITOR_CAPABILITY_BASE.map((capability) => {
    if (capability.family === 'model') {
      return {
        ...capability,
        source: otelUsageEnabled ? 'claude-hooks-status-and-otlp-probe' : 'claude-hooks-and-status',
        limitations: [
          ...capability.limitations,
          otelUsageEnabled
            ? 'The provider version is unknown; OTLP request models are safely probed.'
            : unavailableReason,
        ],
      };
    }
    return capability.family === 'usage'
      ? {
          ...capability,
          support: 'degraded' as const,
          latency: 'response' as const,
          source: otelUsageEnabled ? 'claude-otlp-probe' : 'none',
          contractVersion: capability.contractVersion,
          limitations: [
            ...capability.limitations,
            otelUsageEnabled
              ? 'The provider version is unknown; OTLP request logs are safely probed.'
              : unavailableReason,
            ...(!otelUsageEnabled
              ? ['Settled request usage is unavailable until OTLP request evidence is available.']
              : []),
          ],
        }
      : capability;
  });
}

export const CLAUDE_MONITOR_CAPABILITIES = claudeMonitorCapabilities(true);
