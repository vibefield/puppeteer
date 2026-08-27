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
    source: 'claude-otlp-logs-with-transcript-fallback',
    contractVersion: 'claude-code-api-request@1',
    limitations: [
      'Settled requests are exact; Claude exposes no sanctioned intra-response token delta.',
      'Per-child attribution is present only when Claude emits a native agent id.',
      'Claude tokenSamples omit timestamps, so only callback-time tokenCount is used for child burn rate.',
    ],
  },
  {
    family: 'context',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'sample',
    source: 'claude-status-channels',
    limitations: ['Root is provider-calculated; child values exist only for visible tasks with a resolved model.'],
  },
  {
    family: 'model',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'sample',
    source: 'claude-status-and-transcript',
    limitations: ['Child model is unavailable until Claude resolves it.'],
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
    family: 'planning',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'hook',
    source: 'claude-hooks',
    limitations: ['TodoWrite/ExitPlanMode and pre-transition task facts may remain provisional.'],
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
    family: 'workflow',
    support: 'degraded',
    actorScope: 'current-actors',
    latency: 'sample',
    source: 'claude-otel-and-workflow-journals',
    limitations: [
      'OTLP supplies workflow identity and name; run journals supply exact worker membership and completion.',
    ],
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
  return CLAUDE_MONITOR_CAPABILITY_BASE.map((capability) =>
    capability.family === 'usage'
      ? {
          ...capability,
          support: 'degraded' as const,
          latency: otelUsageEnabled ? ('response' as const) : ('historical' as const),
          source: otelUsageEnabled ? 'claude-otlp-probe-with-transcript-fallback' : 'claude-transcript-jsonl',
          limitations: [
            ...capability.limitations,
            otelUsageEnabled
              ? 'The provider version is unknown; OTLP is safely probed and transcript usage remains the fallback.'
              : unavailableReason,
          ],
        }
      : capability,
  );
}

export const CLAUDE_MONITOR_CAPABILITIES = claudeMonitorCapabilities(true);
