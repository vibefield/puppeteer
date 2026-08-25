/** Grok native-store and ACP facts projected onto the monitor SPI. */

import { randomUUID } from 'node:crypto';
import type { ActorRunRef, AgentEventEnvelope, MonitorMetricFamily } from '@vibecook/chopsticks-core';
import type {
  AdapterMonitorObservationBatch,
  EvidenceRef,
  MonitorFamilyUpdate,
  MonitorFamilyValueMap,
  ObservationCapability,
  ObservationCoverage,
} from '@vibecook/chopsticks-core/monitor-spi';
import type { GrokObservedEvent } from './session-observer.js';

const GROK_CONTRACT = 'grok-native@1.0.0+acp@1.2.1';

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
    support: 'supported',
    actorScope: 'root',
    latency: 'response',
    source: 'grok-turn-completed-usage',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'Canonical usage is emitted only for complete per-turn usage objects.',
      'signals.json and subagent progress are context occupancy, never billed burn.',
      'No verified per-subagent billed usage surface exists on the pinned artifact.',
    ],
  },
  {
    family: 'context',
    support: 'supported',
    actorScope: 'root',
    latency: 'sample',
    source: 'grok-signals-json-and-acp-usage-update',
    contractVersion: GROK_CONTRACT,
    limitations: ['Per-child context is source-backed but absent from the pinned runtime census.'],
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
    family: 'planning',
    support: 'degraded',
    actorScope: 'root',
    latency: 'response',
    source: 'acp-plan',
    contractVersion: GROK_CONTRACT,
    limitations: ['ACP plans are complete snapshots, but Grok plan emission was not exercised in the pinned census.'],
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
      'Child tool calls are not streamed on the parent connection and no agent-team membership identity is verified.',
    ],
  },
  {
    family: 'workflow',
    support: 'unsupported',
    actorScope: 'session',
    latency: 'historical',
    source: 'grok-workflow-extension',
    contractVersion: GROK_CONTRACT,
    limitations: [
      'workflow_updated and goal_updated stay raw until fixtures prove identity, replacement, and artifact semantics.',
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

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function upsert<F extends MonitorMetricFamily>(
  family: F,
  key: string,
  value: MonitorFamilyValueMap[F],
): MonitorFamilyUpdate {
  return { family, operation: 'upsert', key, value } as MonitorFamilyUpdate;
}

function retract(family: MonitorMetricFamily, key: string): MonitorFamilyUpdate {
  return { family, operation: 'retract', key } as MonitorFamilyUpdate;
}

function nestedUpdate(
  value: unknown,
): { params: Record<string, unknown>; update: Record<string, unknown> } | undefined {
  const carrier = rec(value);
  if (!carrier) return undefined;
  const params = rec(carrier.params) ?? carrier;
  const update = rec(params.update);
  return update ? { params, update } : undefined;
}

function sessionUpdate(value: unknown): string | undefined {
  return str(nestedUpdate(value)?.update.sessionUpdate);
}

function safeMode(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  const object = rec(value);
  return str(object?.id) ?? str(object?.value) ?? str(object?.type);
}

function promptUsage(update: Record<string, unknown>): {
  inputTokens?: number;
  outputTokens?: number;
  deltaTokens: number;
} | null {
  const usage = rec(update.usage);
  if (!usage || usage.usageIsIncomplete === true || usage.usage_is_incomplete === true) return null;
  const totalTokens = finiteNonNegative(usage.totalTokens ?? usage.total_tokens);
  const inputTokens = finiteNonNegative(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = finiteNonNegative(usage.outputTokens ?? usage.output_tokens);
  const deltaTokens = totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0);
  if (totalTokens === undefined && inputTokens === undefined && outputTokens === undefined) return null;
  return { inputTokens, outputTokens, deltaTokens };
}

function rawPlan(update: Record<string, unknown>): Array<{ text: string; status: string }> | undefined {
  if (str(update.sessionUpdate) !== 'plan') return undefined;
  const entries = Array.isArray(update.entries) ? update.entries : undefined;
  if (!entries) return undefined;
  return entries.flatMap((value) => {
    const entry = rec(value);
    const text = str(entry?.content);
    const status = str(entry?.status);
    return text && status ? [{ text, status }] : [];
  });
}

function interactionKind(value: string | undefined): 'permission' | 'choice' | 'mixed' {
  if (value === 'permission') return 'permission';
  if (value === 'plan_approval') return 'choice';
  return 'mixed';
}

export interface GrokConfiguredIntent {
  cwd?: string;
  model?: string;
  permissionMode?: string;
  sandbox?: string;
}

export interface GrokMonitorEvidenceOptions {
  nativeSessionId: () => string;
  epoch?: string;
}

/** Stateful projector; raw Grok payloads stay on the compatibility envelope. */
export class GrokMonitorEvidence {
  private readonly epoch: string;
  private sequence = 0;
  private contextCapacity: number | undefined;
  private readonly childTypes = new Map<string, string | undefined>();

  constructor(private readonly options: GrokMonitorEvidenceOptions) {
    this.epoch = options.epoch ?? `grok:${randomUUID()}`;
  }

  private actor(subagentId: string, childSessionId?: string): ActorRunRef {
    const root = this.options.nativeSessionId();
    return {
      rootSessionKey: root,
      runKey: `${root}:actor:${subagentId}`,
      role: 'child',
      parentRunKey: `${root}:root`,
      nativeAgentId: subagentId,
      ...(childSessionId ? { nativeSessionId: childSessionId } : {}),
      ...(this.childTypes.get(subagentId) ? { nativeAgentType: this.childTypes.get(subagentId) } : {}),
    };
  }

  private evidence(id: string): EvidenceRef[] {
    return [{ namespace: 'grok:native-observation', id }];
  }

  private batch(
    label: string,
    observedAt: string,
    updates: MonitorFamilyUpdate[],
    options: {
      phase?: AdapterMonitorObservationBatch['phase'];
      quality?: AdapterMonitorObservationBatch['quality'];
      completeness?: AdapterMonitorObservationBatch['completeness'];
      provisional?: boolean;
      readiness?: AdapterMonitorObservationBatch['readiness'];
      evidence?: EvidenceRef[];
      capabilities?: ObservationCapability[];
      coverage?: ObservationCoverage[];
    } = {},
  ): AdapterMonitorObservationBatch {
    this.sequence += 1;
    return {
      schemaVersion: 1,
      batchId: `${label}:${this.sequence}`,
      producer: {
        id: 'grok:native-monitor',
        epoch: this.epoch,
        sequence: this.sequence,
        contractVersion: GROK_CONTRACT,
      },
      phase: options.phase ?? 'live',
      observedAt,
      quality: options.quality ?? 'exact',
      completeness: options.completeness ?? 'partial',
      provisional: options.provisional ?? false,
      readiness: options.readiness ?? 'ready',
      scope: { nativeSessionId: this.options.nativeSessionId() },
      updates,
      sourceWatermarks: [],
      evidence: options.evidence ?? [],
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.coverage ? { coverage: options.coverage } : {}),
    };
  }

  capabilitiesBatch(observedAt: string): AdapterMonitorObservationBatch {
    return this.batch('capabilities', observedAt, [], {
      phase: 'bootstrap',
      completeness: 'complete',
      capabilities: [...GROK_MONITOR_CAPABILITIES],
    });
  }

  configuredBatch(configured: GrokConfiguredIntent, observedAt: string): AdapterMonitorObservationBatch | null {
    const updates: MonitorFamilyUpdate[] = [];
    if (configured.cwd) updates.push(upsert('environment', 'root', { kind: 'environment', cwd: configured.cwd }));
    if (configured.model) {
      updates.push(
        upsert('model', 'configured', {
          kind: 'model',
          providerModelId: configured.model,
          intent: 'configured',
        }),
      );
    }
    const permission = [
      configured.permissionMode ? `permission:${configured.permissionMode}` : undefined,
      configured.sandbox ? `sandbox:${configured.sandbox}` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join('; ');
    if (permission) {
      updates.push(
        upsert('mode', 'provider-permission-configured', {
          kind: 'mode',
          modeKind: 'provider-permission',
          raw: permission,
          intent: 'configured',
        }),
      );
    }
    if (updates.length === 0) return null;
    return this.batch('configured', observedAt, updates, {
      phase: 'bootstrap',
      completeness: 'complete',
      evidence: this.evidence('launch-intent'),
    });
  }

  observedBatch(observed: GrokObservedEvent, observedAt: string): AdapterMonitorObservationBatch | null {
    return this.eventBatch(
      observed.event,
      observed.nativeEvent,
      observedAt,
      observed.phase ?? 'live',
      observed.promptId,
    );
  }

  controlEnvelopeBatch(envelope: AgentEventEnvelope): AdapterMonitorObservationBatch | null {
    const replay = envelope.replay === true || rec(nestedUpdate(envelope.nativeEvent)?.params._meta)?.isReplay === true;
    return this.eventBatch(
      envelope.event,
      envelope.nativeEvent,
      envelope.timestamp,
      replay ? 'bootstrap' : 'live',
      envelope.promptId ?? envelope.turnId,
    );
  }

  private eventBatch(
    event: AgentEventEnvelope['event'],
    nativeEvent: unknown,
    observedAt: string,
    phase: 'bootstrap' | 'live',
    promptId?: string,
  ): AdapterMonitorObservationBatch | null {
    const nested = nestedUpdate(nativeEvent);
    const update = nested?.update;
    const kind = str(update?.sessionUpdate);
    const updates: MonitorFamilyUpdate[] = [];
    let quality: AdapterMonitorObservationBatch['quality'] = 'exact';
    let provisional = false;

    if (event.type === 'context-window.updated') {
      this.contextCapacity = event.capacityTokens;
      updates.push(
        upsert('context', 'root', {
          kind: 'context',
          usedTokens: event.usedTokens,
          capacityTokens: event.capacityTokens,
          ...(event.usedPercentage !== undefined ? { usedPercentage: event.usedPercentage } : {}),
          percentageSource: event.usedPercentage !== undefined ? (event.percentageSource ?? 'provider') : 'derived',
        }),
      );
      if (event.modelId) {
        updates.push(
          upsert('model', 'observed', {
            kind: 'model',
            providerModelId: event.modelId,
            intent: 'observed',
          }),
        );
      }
    } else if (event.type === 'context-window.invalidated') {
      updates.push(retract('context', 'root'));
      if (event.reason === 'compacted') {
        updates.push(upsert('compaction', 'root', { kind: 'compaction', active: false, trigger: 'signals-counter' }));
        quality = 'strong';
      }
    } else if (event.type === 'session.environment.updated') {
      if (event.currentCwd !== undefined) {
        updates.push(upsert('environment', 'root', { kind: 'environment', cwd: event.currentCwd }));
      }
      if (event.model) {
        updates.push(
          upsert('model', 'observed', {
            kind: 'model',
            providerModelId: event.model.id,
            ...(event.model.displayName ? { displayName: event.model.displayName } : {}),
            intent: 'observed',
          }),
        );
      }
    }

    const isTurnCompletedEvent =
      event.type === 'turn.completed' ||
      (event.type === 'adapter.native-event' && event.adapter === 'grok' && event.nativeType === 'turn_completed');
    if (isTurnCompletedEvent && kind === 'turn_completed' && update) {
      const usage = promptUsage(update);
      const usagePromptId = str(update.prompt_id) ?? promptId;
      if (usage && usagePromptId) {
        const usageId = `grok-turn:${this.options.nativeSessionId()}:${usagePromptId}`;
        updates.push(
          upsert('usage', usageId, {
            kind: 'usage',
            usageId,
            boundary: 'response',
            canonical: true,
            deltaTokens: usage.deltaTokens,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          }),
        );
      }
    }

    const plan = update ? rawPlan(update) : undefined;
    if (plan) {
      if (plan.length === 0) updates.push(retract('planning', 'plan:root'));
      else {
        updates.push(
          upsert('planning', 'plan:root', {
            kind: 'plan',
            planId: 'grok-acp-plan:root',
            steps: plan,
            provisional: false,
          }),
        );
      }
      quality = 'strong';
    }

    if (kind === 'current_mode_update' && update) {
      const mode = safeMode(update.currentModeId ?? update.current_mode_id);
      if (mode) {
        updates.push(
          upsert('mode', 'provider-session-observed', {
            kind: 'mode',
            modeKind: 'provider-session',
            raw: mode,
            intent: 'observed',
          }),
        );
      }
      quality = 'strong';
    }

    if (kind === 'model_changed' && update) {
      const modelId = str(update.model_id) ?? str(update.modelId);
      const effort = str(update.reasoning_effort) ?? str(update.reasoningEffort);
      if (modelId) {
        updates.push(upsert('model', 'observed', { kind: 'model', providerModelId: modelId, intent: 'observed' }));
      }
      if (effort) {
        updates.push(upsert('effort', 'observed', { kind: 'effort', value: effort, intent: 'observed' }));
      }
      quality = 'unknown';
      provisional = true;
    }

    if (kind === 'pending_interaction' && update) {
      const interactionId = str(update.tool_call_id) ?? str(update.toolCallId);
      const nativeKind = str(update.kind);
      if (interactionId) {
        updates.push(
          upsert('status', `interaction:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: interactionKind(nativeKind),
            state: 'pending',
            detail: nativeKind ? `Grok ${nativeKind.replaceAll('_', ' ')}` : 'Grok needs input',
          }),
        );
      }
      quality = 'unknown';
      provisional = true;
    } else if (kind === 'interaction_resolved' && update) {
      const interactionId = str(update.tool_call_id) ?? str(update.toolCallId);
      if (interactionId) {
        updates.push(
          upsert('status', `interaction:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: 'mixed',
            state: 'resolved',
          }),
        );
      }
      quality = 'unknown';
      provisional = true;
    }

    if (kind === 'subagent_spawned' && update) {
      const childId = str(update.subagent_id) ?? str(update.child_session_id);
      if (childId) {
        this.childTypes.set(childId, str(update.subagent_type));
        const actor = this.actor(childId, str(update.child_session_id));
        updates.push(upsert('delegation', `actor:${actor.runKey}`, { kind: 'actor', actor, state: 'active' }));
        const modelId = str(update.model);
        if (modelId) {
          updates.push(
            upsert('model', `actor:${actor.runKey}`, {
              kind: 'model',
              actor,
              providerModelId: modelId,
              intent: 'configured',
            }),
          );
        }
      }
      quality = 'unknown';
      provisional = true;
    } else if (kind === 'subagent_progress' && update) {
      const childId = str(update.subagent_id) ?? str(update.child_session_id);
      if (childId) {
        const actor = this.actor(childId, str(update.child_session_id));
        updates.push(
          upsert('delegation', `actor:${actor.runKey}`, {
            kind: 'actor',
            actor,
            state: 'active',
            activity: 'Subagent active',
          }),
        );
        const usedTokens = finiteNonNegative(update.tokens_used ?? update.tokensUsed);
        const capacityTokens = finiteNonNegative(update.context_window_tokens ?? update.contextWindowTokens);
        if (usedTokens !== undefined && capacityTokens !== undefined && capacityTokens > 0) {
          updates.push(
            upsert('context', `actor:${actor.runKey}`, {
              kind: 'context',
              actor,
              usedTokens,
              capacityTokens,
              percentageSource: 'derived',
            }),
          );
        }
      }
      quality = 'unknown';
      provisional = true;
    } else if (kind === 'subagent_finished' && update) {
      const childId = str(update.subagent_id) ?? str(update.child_session_id);
      if (childId) {
        const actor = this.actor(childId, str(update.child_session_id));
        updates.push(upsert('delegation', `actor:${actor.runKey}`, { kind: 'actor', actor, state: 'stopped' }));
      }
      quality = 'unknown';
      provisional = true;
    }

    if (kind === 'auto_compact_started' && update) {
      updates.push(upsert('compaction', 'root', { kind: 'compaction', active: true, trigger: 'auto' }));
      const usedTokens = finiteNonNegative(update.tokens_used ?? update.tokensUsed);
      const capacityTokens = finiteNonNegative(update.context_window ?? update.contextWindow);
      if (usedTokens !== undefined && capacityTokens !== undefined && capacityTokens > 0) {
        this.contextCapacity = capacityTokens;
        updates.push(
          upsert('context', 'root', {
            kind: 'context',
            usedTokens,
            capacityTokens,
            percentageSource: 'derived',
          }),
        );
      }
      quality = 'unknown';
      provisional = true;
    } else if (kind === 'auto_compact_completed' && update) {
      updates.push(upsert('compaction', 'root', { kind: 'compaction', active: false, trigger: 'auto' }));
      const usedTokens = finiteNonNegative(update.tokens_after ?? update.tokensAfter);
      if (usedTokens !== undefined && this.contextCapacity !== undefined) {
        updates.push(
          upsert('context', 'root', {
            kind: 'context',
            usedTokens,
            capacityTokens: this.contextCapacity,
            percentageSource: 'derived',
          }),
        );
      } else {
        updates.push(retract('context', 'root'));
      }
      quality = 'unknown';
      provisional = true;
    } else if (kind === 'auto_compact_failed' || kind === 'auto_compact_cancelled') {
      updates.push(
        upsert('compaction', 'root', {
          kind: 'compaction',
          active: false,
          trigger: kind === 'auto_compact_failed' ? 'failed' : 'cancelled',
        }),
      );
      quality = 'unknown';
      provisional = true;
    } else if (kind === 'compaction_checkpoint') {
      updates.push(upsert('compaction', 'root', { kind: 'compaction', active: false, trigger: 'checkpoint' }));
      quality = 'unknown';
      provisional = true;
    }

    // workflow_updated and goal_updated deliberately remain raw. Their current
    // source contains plausible IDs, but the RFC requires replacement and
    // artifact semantics to be proven by pinned fixtures before projection.
    if (updates.length === 0) return null;
    const evidenceId =
      [
        kind ?? event.type,
        str(update?.prompt_id) ?? promptId,
        str(update?.subagent_id),
        str(update?.run_id),
        str(update?.tool_call_id),
      ]
        .filter((value): value is string => value !== undefined)
        .join(':') || `${event.type}:${this.sequence + 1}`;
    return this.batch(kind ?? event.type.replaceAll('.', '-'), observedAt, updates, {
      phase,
      quality,
      provisional,
      evidence: this.evidence(evidenceId),
    });
  }

  /** ACP/control loss degrades readiness but never claims that the native TUI died. */
  controlUnavailableBatch(observedAt: string, nativeObserverAvailable: boolean): AdapterMonitorObservationBatch {
    const affectedFamilies: MonitorMetricFamily[] = nativeObserverAvailable
      ? ['status']
      : GROK_MONITOR_CAPABILITIES.filter(({ support }) => support !== 'unsupported').map(({ family }) => family);
    const affected = new Set(affectedFamilies);
    const capabilities = GROK_MONITOR_CAPABILITIES.map((capability) =>
      affected.has(capability.family)
        ? {
            ...capability,
            support: 'degraded' as const,
            limitations: [
              ...capability.limitations,
              'ACP control rail unavailable; native host liveness is unchanged.',
            ],
          }
        : capability,
    );
    const coverage: ObservationCoverage[] = affectedFamilies.map((family) => ({
      family,
      completeness: nativeObserverAvailable ? 'partial' : 'unavailable',
      asOf: observedAt,
      reason: nativeObserverAvailable
        ? 'structured control and interaction observation unavailable'
        : 'Grok control observation rail unavailable',
    }));
    return this.batch('control-unavailable', observedAt, [], {
      quality: 'unknown',
      completeness: nativeObserverAvailable ? 'partial' : 'unavailable',
      readiness: 'degraded',
      evidence: this.evidence(`control-unavailable:${this.sequence + 1}`),
      capabilities,
      coverage,
    });
  }
}

/** Narrow helper used by tests and callers retaining raw extension events. */
export function grokNativeSessionUpdate(value: unknown): string | undefined {
  return sessionUpdate(value);
}
