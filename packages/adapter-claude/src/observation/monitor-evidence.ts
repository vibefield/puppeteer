/** Claude-local status and hook evidence for the correction-aware monitor SPI. */

import type { ActorRunRef } from '@vibecook/puppeteer-core';
import type {
  AdapterMonitorObservationBatch,
  EvidenceRef,
  MonitorFamilyUpdate,
  MonitorFamilyValueMap,
  MonitorUsageFamilyValue,
  ObservationCapability,
  ObservationCoverage,
} from '@vibecook/puppeteer-core/monitor-spi';
import type { MonitorMetricFamily } from '@vibecook/puppeteer-core';
import {
  claudeContextWindowEvent,
  claudeEnvironmentEvent,
  claudeSubagentStatusTasks,
  claudeStatusChannelMetadata,
} from './status-channel.js';

const STATUS_CONTRACT = 'claude-status-channel@1';
const MAX_STATUS_SAMPLES = 256;

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

function nativeAgentActor(nativeSessionId: string, agentId: string, agentType?: string): ActorRunRef {
  return {
    rootSessionKey: nativeSessionId,
    runKey: `${nativeSessionId}:actor:${agentId}`,
    role: 'child',
    parentRunKey: `${nativeSessionId}:root`,
    nativeSessionId,
    nativeAgentId: agentId,
    ...(agentType ? { nativeAgentType: agentType } : {}),
  };
}

function unverifiedStatusTaskActor(nativeSessionId: string, taskId: string, agentType?: string): ActorRunRef {
  return {
    rootSessionKey: nativeSessionId,
    runKey: `${nativeSessionId}:status-task:${taskId}`,
    role: 'child',
    parentRunKey: `${nativeSessionId}:root`,
    nativeSessionId,
    ...(agentType ? { nativeAgentType: agentType } : {}),
  };
}

const TERMINAL_CHILD_STATUSES = new Set(['cancelled', 'completed', 'done', 'failed', 'stopped']);

function childActivityLine(task: ReturnType<typeof claudeSubagentStatusTasks>[number]): string {
  return task.label ?? task.description ?? task.status ?? task.name ?? task.type ?? 'Subagent active';
}

function upsert<F extends MonitorMetricFamily>(
  family: F,
  key: string,
  value: MonitorFamilyValueMap[F],
): MonitorFamilyUpdate {
  return { family, operation: 'upsert', key, value } as MonitorFamilyUpdate;
}

function replace<F extends MonitorMetricFamily>(
  family: F,
  values: Array<{ key: string; value: MonitorFamilyValueMap[F] }>,
): MonitorFamilyUpdate {
  return { family, operation: 'replace', coverage: 'complete', values } as MonitorFamilyUpdate;
}

function statusEvidence(id: string): EvidenceRef[] {
  return [{ namespace: 'claude-status-channel', id }];
}

function hookEvidence(id: string): EvidenceRef[] {
  return [{ namespace: 'claude-native-hook', id }];
}

interface ChildSample {
  key: string;
  value: MonitorUsageFamilyValue;
}

export interface ClaudeMonitorEvidenceOptions {
  nativeSessionId: () => string;
  epoch?: string;
  otelUsageEnabled?: boolean;
  otelUsageUnavailableReason?: string;
  otelUsageVerified?: boolean;
}

/** Stateful root/child status batch builder; the original payload stays on the native envelope. */
export class ClaudeMonitorEvidence {
  private readonly baseEpoch: string;
  private statusEpoch: string;
  private currentNativeSessionId: string;
  private statusGeneration = 1;
  private rootNeedsResync = false;
  private childNeedsResync = false;
  private capabilitySequence = 0;
  private rootSequence = 0;
  private childSequence = 0;
  private readonly childSamples = new Map<string, ChildSample[]>();
  private readonly nativeAgentTypes = new Map<string, string | undefined>();
  private readonly stoppedNativeAgents = new Set<string>();
  private readonly capabilities: readonly ObservationCapability[];

  constructor(private readonly options: ClaudeMonitorEvidenceOptions) {
    this.currentNativeSessionId = options.nativeSessionId();
    this.baseEpoch = options.epoch ?? `status:${this.currentNativeSessionId}`;
    this.statusEpoch = `${this.baseEpoch}:${this.statusGeneration}`;
    this.capabilities = claudeMonitorCapabilities(
      options.otelUsageEnabled !== false,
      options.otelUsageUnavailableReason,
      options.otelUsageVerified,
    );
  }

  capabilitiesBatch(observedAt: string): AdapterMonitorObservationBatch {
    this.capabilitySequence += 1;
    const batch: AdapterMonitorObservationBatch = {
      schemaVersion: 1,
      batchId: `capabilities:${this.capabilitySequence}`,
      producer: {
        id: 'claude:adapter-capabilities',
        epoch: this.baseEpoch,
        sequence: this.capabilitySequence,
        contractVersion: STATUS_CONTRACT,
      },
      phase: 'bootstrap',
      observedAt,
      quality: 'exact',
      completeness: 'complete',
      provisional: false,
      readiness: 'ready',
      scope: { nativeSessionId: this.options.nativeSessionId() },
      updates: [],
      sourceWatermarks: [],
      evidence: [],
      capabilities: [...this.capabilities],
    };
    return batch;
  }

  /** Hook-rail loss degrades evidence only; it does not imply that the native Claude process exited. */
  hookRailUnavailableBatch(
    observedAt: string,
    reason = 'Claude hook bridge unavailable',
    currentCapabilities: readonly ObservationCapability[] = this.capabilities,
  ): AdapterMonitorObservationBatch {
    this.capabilitySequence += 1;
    const capabilities = currentCapabilities.map((capability) =>
      capability.support === 'unsupported'
        ? capability
        : {
            ...capability,
            support: 'degraded' as const,
            limitations: [...capability.limitations, `${reason}; native TUI host liveness is unchanged.`],
          },
    );
    const coverage: ObservationCoverage[] = currentCapabilities
      .filter(({ support }) => support !== 'unsupported')
      .map(({ family }) => ({ family, completeness: 'unavailable', asOf: observedAt, reason }));
    return {
      schemaVersion: 1,
      batchId: `hook-rail-unavailable:${this.capabilitySequence}`,
      producer: {
        id: 'claude:adapter-capabilities',
        epoch: this.baseEpoch,
        sequence: this.capabilitySequence,
        contractVersion: STATUS_CONTRACT,
      },
      phase: 'live',
      observedAt,
      quality: 'unknown',
      completeness: 'unavailable',
      provisional: false,
      readiness: 'degraded',
      scope: { nativeSessionId: this.options.nativeSessionId() },
      updates: [],
      sourceWatermarks: [],
      evidence: [{ namespace: 'claude:hook-bridge-rail', id: `unavailable:${this.capabilitySequence}` }],
      capabilities,
      coverage,
    };
  }

  /** A `/clear`-style native identity rotation starts replacement epochs for both status producers. */
  observeNativeSession(nativeSessionId: string): void {
    if (nativeSessionId === this.currentNativeSessionId) return;
    this.currentNativeSessionId = nativeSessionId;
    this.statusGeneration += 1;
    this.statusEpoch = `${this.baseEpoch}:${this.statusGeneration}`;
    this.rootSequence = 0;
    this.childSequence = 0;
    this.rootNeedsResync = true;
    this.childNeedsResync = true;
    this.childSamples.clear();
    this.nativeAgentTypes.clear();
    this.stoppedNativeAgents.clear();
  }

  /** Hook `agent_id` is the join proof for otherwise task-scoped status rows. */
  observeNativeAgent(agentId: string, agentType?: string): void {
    this.nativeAgentTypes.set(agentId, agentType);
    const samples = this.childSamples.get(agentId);
    if (!samples) return;
    const actor = nativeAgentActor(this.options.nativeSessionId(), agentId, agentType);
    for (const sample of samples) sample.value = { ...sample.value, actor };
  }

  observeNativeAgentStarted(agentId: string, agentType?: string): void {
    this.observeNativeAgent(agentId, agentType);
    this.stoppedNativeAgents.delete(agentId);
  }

  observeNativeAgentStopped(agentId: string, agentType?: string): void {
    this.observeNativeAgent(agentId, agentType);
    this.stoppedNativeAgents.add(agentId);
  }

  /**
   * Hook-driven history changes invalidate the complete root status snapshot.
   * A generic runtime retraction cannot remove another producer's replacement
   * row, so clear the status producer explicitly as well.
   */
  rootContextInvalidationBatch(observedAt: string, evidenceId: string): AdapterMonitorObservationBatch {
    return this.rootBatch([replace('context', [])], observedAt, hookEvidence(evidenceId), this.currentNativeSessionId);
  }

  rootStatusBatch(payload: unknown, observedAt: string, evidenceId: string): AdapterMonitorObservationBatch | null {
    const environment = claudeEnvironmentEvent(payload);
    const context = claudeContextWindowEvent(payload);
    if (!environment && !context) return null;
    const metadata = claudeStatusChannelMetadata(payload);
    if (metadata.nativeSessionId) this.observeNativeSession(metadata.nativeSessionId);
    const nativeSessionId = metadata.nativeSessionId ?? this.options.nativeSessionId();
    const nextSequence = this.rootSequence + 1;
    const updates: MonitorFamilyUpdate[] = [];

    if (environment?.currentCwd !== undefined) {
      updates.push(
        upsert('environment', 'root', {
          kind: 'environment',
          cwd: environment.currentCwd,
        }),
      );
    }
    if (environment?.model) {
      updates.push(
        replace('model', [
          {
            key: 'observed',
            value: {
              kind: 'model',
              providerModelId: environment.model.id,
              ...(environment.model.displayName ? { displayName: environment.model.displayName } : {}),
              intent: 'observed',
            },
          },
        ]),
      );
    }
    if (environment?.effort !== undefined) {
      updates.push(
        replace(
          'effort',
          environment?.effort
            ? [
                {
                  key: 'observed',
                  value: { kind: 'effort', value: environment.effort, intent: 'observed' },
                },
              ]
            : [],
        ),
      );
    }
    if (payload && typeof payload === 'object' && 'context_window' in payload) {
      updates.push(
        replace(
          'context',
          context?.type === 'context-window.updated'
            ? [
                {
                  key: 'root',
                  value: {
                    kind: 'context',
                    usedTokens: context.usedTokens,
                    capacityTokens: context.capacityTokens,
                    ...(context.usedPercentage !== undefined ? { usedPercentage: context.usedPercentage } : {}),
                    percentageSource:
                      context.usedPercentage !== undefined ? (context.percentageSource ?? 'provider') : 'derived',
                  },
                },
              ]
            : [],
        ),
      );
    }
    if (updates.length === 0) return null;

    return this.rootBatch(updates, observedAt, statusEvidence(evidenceId), nativeSessionId, nextSequence);
  }

  private rootBatch(
    updates: MonitorFamilyUpdate[],
    observedAt: string,
    evidence: EvidenceRef[],
    nativeSessionId: string,
    sequence = this.rootSequence + 1,
  ): AdapterMonitorObservationBatch {
    this.rootSequence = sequence;
    const batch: AdapterMonitorObservationBatch = {
      schemaVersion: 1,
      batchId: `root:${this.rootSequence}`,
      producer: {
        id: 'claude:status-root',
        epoch: this.statusEpoch,
        sequence: this.rootSequence,
        contractVersion: STATUS_CONTRACT,
      },
      phase: this.rootNeedsResync ? 'resync' : 'live',
      observedAt,
      quality: 'exact',
      completeness: 'complete',
      provisional: false,
      readiness: 'ready',
      scope: { nativeSessionId },
      updates,
      sourceWatermarks: [],
      evidence,
    };
    this.rootNeedsResync = false;
    return batch;
  }

  childStatusBatch(payload: unknown, observedAt: string, evidenceId: string): AdapterMonitorObservationBatch | null {
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { tasks?: unknown }).tasks)) return null;
    const metadata = claudeStatusChannelMetadata(payload);
    if (metadata.nativeSessionId) this.observeNativeSession(metadata.nativeSessionId);
    const nativeSessionId = metadata.nativeSessionId ?? this.options.nativeSessionId();
    const tasks = claudeSubagentStatusTasks(payload);
    const visibleIds = new Set(tasks.map((task) => task.id));
    for (const id of this.childSamples.keys()) {
      if (!visibleIds.has(id)) this.childSamples.delete(id);
    }

    const statuses: MonitorFamilyUpdate[] = [];
    const contexts: Array<{ key: string; value: MonitorFamilyValueMap['context'] }> = [];
    const models: Array<{ key: string; value: MonitorFamilyValueMap['model'] }> = [];
    const efforts: Array<{ key: string; value: MonitorFamilyValueMap['effort'] }> = [];
    for (const task of tasks) {
      const actor = this.nativeAgentTypes.has(task.id)
        ? nativeAgentActor(nativeSessionId, task.id, this.nativeAgentTypes.get(task.id) ?? task.type ?? task.name)
        : unverifiedStatusTaskActor(nativeSessionId, task.id, task.type ?? task.name);
      const status = task.status?.toLowerCase();
      const stoppedByHook = this.stoppedNativeAgents.has(task.id);
      statuses.push(
        upsert('status', `child-activity:${task.id}`, {
          kind: 'activity',
          activityKind: 'delegating',
          active: !stoppedByHook && (status === undefined || !TERMINAL_CHILD_STATUSES.has(status)),
          line: childActivityLine(task),
          actor,
          leaseId: `claude-child-status:${nativeSessionId}:${task.id}`,
        }),
      );
      if (task.model) {
        models.push({
          key: `actor:${actor.runKey}`,
          value: {
            kind: 'model',
            actor,
            providerModelId: task.model,
            intent: 'observed',
          },
        });
      }
      if (task.effort) {
        efforts.push({
          key: `actor:${actor.runKey}`,
          value: {
            kind: 'effort',
            actor,
            value: task.effort,
            intent: 'configured',
          },
        });
      }
      if (task.tokenCount !== undefined && task.contextWindowSize !== undefined && task.contextWindowSize > 0) {
        contexts.push({
          key: `actor:${actor.runKey}`,
          value: {
            kind: 'context',
            actor,
            usedTokens: task.tokenCount,
            capacityTokens: task.contextWindowSize,
            usedPercentage: Math.min(100, Math.max(0, (task.tokenCount / task.contextWindowSize) * 100)),
            percentageSource: 'derived',
          },
        });
      }
      if (task.tokenCount !== undefined) {
        const samples = this.childSamples.get(task.id) ?? [];
        samples.push({
          key: `child:${task.id}:sample:${this.childSequence + 1}`,
          value: {
            kind: 'usage',
            usageId: `child:${task.id}:sample:${this.childSequence + 1}`,
            actor,
            boundary: 'sample',
            canonical: false,
            cumulativeTokens: task.tokenCount,
          },
        });
        if (samples.length > MAX_STATUS_SAMPLES) samples.splice(0, samples.length - MAX_STATUS_SAMPLES);
        this.childSamples.set(task.id, samples);
      }
    }

    this.childSequence += 1;
    const usages = [...this.childSamples.values()].flat().map((sample) => ({
      key: sample.key,
      value: sample.value,
    }));
    const batch: AdapterMonitorObservationBatch = {
      schemaVersion: 1,
      batchId: `child:${this.childSequence}`,
      producer: {
        id: 'claude:status-child',
        epoch: this.statusEpoch,
        sequence: this.childSequence,
        contractVersion: STATUS_CONTRACT,
      },
      phase: this.childNeedsResync ? 'resync' : 'live',
      observedAt,
      quality: 'exact',
      completeness: 'partial',
      provisional: false,
      readiness: 'ready',
      scope: { nativeSessionId },
      updates: [
        ...statuses,
        replace('context', contexts),
        replace('model', models),
        replace('effort', efforts),
        replace('usage', usages),
      ],
      sourceWatermarks: [],
      evidence: statusEvidence(evidenceId),
    };
    this.childNeedsResync = false;
    return batch;
  }
}
