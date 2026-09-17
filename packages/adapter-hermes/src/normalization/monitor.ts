/** Hermes 0.20.0 tui_gateway facts projected onto the evidence-backed monitor SPI. */

import { createHash, randomUUID } from 'node:crypto';
import type { ActorRunRef, MonitorMetricFamily } from '@vibecook/puppeteer-core';
import type {
  AdapterMonitorObservationBatch,
  EvidenceRef,
  MonitorFamilyUpdate,
  MonitorFamilyValueMap,
  ObservationCapability,
  ObservationCoverage,
} from '@vibecook/puppeteer-core/monitor-spi';
import { hermesStructuredQuestions } from './interaction.js';
import { eventType, type HermesGatewayFrame } from '../transport/jsonrpc.js';
import { HERMES_CONTRACT, HERMES_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

export { HERMES_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

const MAX_TEXT_LENGTH = 4_096;
const MAX_USAGE_IDENTITIES = 1_024;
const MAX_INTERACTIONS = 256;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

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

function digest(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return createHash('sha256').update(serialized).digest('hex').slice(0, 24);
}

function eventPayload(frame: HermesGatewayFrame): Record<string, unknown> {
  return record(frame.params?.payload) ?? {};
}

function eventSessionId(frame: HermesGatewayFrame): string | undefined {
  return text(frame.params?.session_id);
}

function modelCard(provider: unknown, model: unknown): string | undefined {
  const modelId = text(model);
  if (!modelId) return undefined;
  const providerId = text(provider);
  return providerId ? `${providerId}/${modelId}` : modelId;
}

interface UsageSnapshot {
  cumulativeTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  calls?: number;
  compressions?: number;
}

function usageSnapshot(value: unknown): UsageSnapshot | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const inputTokens = finiteNonNegative(usage.input ?? usage.prompt);
  const outputTokens = finiteNonNegative(usage.output ?? usage.completion);
  const reasoningTokens = finiteNonNegative(usage.reasoning);
  const total = finiteNonNegative(usage.total);
  if (total === undefined && inputTokens === undefined && outputTokens === undefined && reasoningTokens === undefined) {
    return undefined;
  }
  const calls = finiteNonNegative(usage.calls);
  const compressions = finiteNonNegative(usage.compressions);
  return {
    cumulativeTokens: total ?? (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(calls !== undefined ? { calls } : {}),
    ...(compressions !== undefined ? { compressions } : {}),
  };
}

interface ChildIdentity {
  id: string;
  childSessionId?: string;
  parentId?: string;
  model?: string;
}

export interface HermesConfiguredIntent {
  cwd: string;
  yolo?: boolean;
}

export interface HermesMonitorEvidenceOptions {
  nativeSessionId: () => string;
  liveSessionId?: () => string | undefined;
  epoch?: string | undefined;
}

export class HermesMonitorEvidence {
  private readonly epoch: string;
  private sequence = 0;
  private readonly usageIdentities = new Set<string>();
  private readonly children = new Map<string, ChildIdentity>();
  private readonly pendingQuestions = new Map<string, 'choice' | 'multi-choice' | 'free-form' | 'mixed'>();
  private readonly activeTools = new Map<string, string>();
  private readonly pendingPermissions = new Map<string, string>();
  private uncorrelatedPermission: string | undefined;
  private compactionActive = false;
  private lastCompressionCount: number | undefined;

  constructor(private readonly options: HermesMonitorEvidenceOptions) {
    this.epoch = options.epoch ?? `hermes:${randomUUID()}`;
  }

  private retainUsageIdentity(id: string): boolean {
    if (this.usageIdentities.has(id)) return false;
    this.usageIdentities.add(id);
    while (this.usageIdentities.size > MAX_USAGE_IDENTITIES) {
      const oldest = this.usageIdentities.values().next().value as string | undefined;
      if (!oldest) break;
      this.usageIdentities.delete(oldest);
    }
    return true;
  }

  private retainQuestion(id: string, kind: 'choice' | 'multi-choice' | 'free-form' | 'mixed'): void {
    this.pendingQuestions.delete(id);
    this.pendingQuestions.set(id, kind);
    while (this.pendingQuestions.size > MAX_INTERACTIONS) {
      const oldest = this.pendingQuestions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pendingQuestions.delete(oldest);
    }
  }

  private actor(payload: Record<string, unknown>): ActorRunRef | undefined {
    const childSessionId = text(payload.child_session_id);
    const id = text(payload.subagent_id) ?? childSessionId;
    if (!id) return undefined;
    const prior = this.children.get(id);
    const parentId = text(payload.parent_id) ?? prior?.parentId;
    const model = text(payload.model) ?? prior?.model;
    const resolvedChildSessionId = childSessionId ?? prior?.childSessionId;
    const identity: ChildIdentity = {
      id,
      ...(resolvedChildSessionId ? { childSessionId: resolvedChildSessionId } : {}),
      ...(parentId ? { parentId } : {}),
      ...(model ? { model } : {}),
    };
    this.children.set(id, identity);
    const root = this.options.nativeSessionId();
    const rootParent =
      !identity.parentId || identity.parentId === root || identity.parentId === this.options.liveSessionId?.();
    return {
      rootSessionKey: root,
      runKey: `${root}:actor:${id}`,
      role: 'child',
      parentRunKey: rootParent ? `${root}:root` : `${root}:actor:${identity.parentId}`,
      ...(identity.childSessionId ? { nativeSessionId: identity.childSessionId } : {}),
      nativeAgentId: id,
    };
  }

  private evidence(frame: HermesGatewayFrame, nativeType: string): EvidenceRef[] {
    return [
      {
        namespace: 'hermes:tui-gateway-frame',
        id: `${eventSessionId(frame) ?? this.options.liveSessionId?.() ?? 'session'}:${nativeType}:${digest(frame)}`,
        revisionKey: digest(frame),
        ...(eventSessionId(frame) ? { sourceObjectId: eventSessionId(frame) } : {}),
      },
    ];
  }

  private batch(
    label: string,
    observedAt: string,
    updates: MonitorFamilyUpdate[],
    options: {
      phase?: AdapterMonitorObservationBatch['phase'] | undefined;
      quality?: AdapterMonitorObservationBatch['quality'] | undefined;
      completeness?: AdapterMonitorObservationBatch['completeness'] | undefined;
      provisional?: boolean | undefined;
      readiness?: AdapterMonitorObservationBatch['readiness'] | undefined;
      actor?: ActorRunRef | undefined;
      evidence?: EvidenceRef[] | undefined;
      capabilities?: ObservationCapability[] | undefined;
      coverage?: ObservationCoverage[] | undefined;
    } = {},
  ): AdapterMonitorObservationBatch {
    this.sequence += 1;
    return {
      schemaVersion: 1,
      batchId: `${label}:${this.sequence}`,
      producer: {
        id: 'hermes:tui-gateway-monitor',
        epoch: this.epoch,
        sequence: this.sequence,
        contractVersion: HERMES_CONTRACT,
      },
      phase: options.phase ?? 'live',
      observedAt,
      quality: options.quality ?? 'exact',
      completeness: options.completeness ?? 'partial',
      provisional: options.provisional ?? false,
      readiness: options.readiness ?? 'ready',
      scope: {
        nativeSessionId: this.options.nativeSessionId(),
        ...(options.actor ? { actorRunKey: options.actor.runKey } : {}),
      },
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
      capabilities: [...HERMES_MONITOR_CAPABILITIES],
      evidence: [{ namespace: 'hermes:surface-contract', id: HERMES_CONTRACT }],
    });
  }

  configuredBatch(configured: HermesConfiguredIntent, observedAt: string): AdapterMonitorObservationBatch {
    const updates: MonitorFamilyUpdate[] = [
      upsert('environment', 'root', { kind: 'environment', cwd: configured.cwd }),
    ];
    if (configured.yolo === true) {
      updates.push(
        upsert('mode', 'provider-permission-configured', {
          kind: 'mode',
          modeKind: 'provider-permission',
          raw: 'yolo',
          normalized: 'auto',
          intent: 'configured',
        }),
      );
    }
    return this.batch('configured', observedAt, updates, {
      phase: 'bootstrap',
      completeness: 'complete',
      evidence: [{ namespace: 'hermes:launch-intent', id: digest(configured) }],
    });
  }

  recordBatch(
    frame: HermesGatewayFrame,
    observedAt: string,
    phase: 'bootstrap' | 'live' = 'live',
  ): AdapterMonitorObservationBatch | null {
    const nativeType = eventType(frame);
    if (!nativeType) return null;
    const payload = eventPayload(frame);
    const updates: MonitorFamilyUpdate[] = [];
    let actor: ActorRunRef | undefined;
    let quality: AdapterMonitorObservationBatch['quality'] = 'exact';

    const appendUsage = (usageValue: unknown): void => {
      const usage = usageSnapshot(usageValue);
      if (!usage) return;
      const identity = `root:${usage.calls ?? 'unknown'}:${usage.cumulativeTokens}:${digest(usage)}`;
      if (this.retainUsageIdentity(identity)) {
        const usageId = `hermes-sample:${this.options.nativeSessionId()}:${identity}`;
        updates.push(
          upsert('usage', usageId, {
            kind: 'usage',
            origin: 'protocol',
            usageId,
            boundary: 'sample',
            canonical: false,
            cumulativeTokens: usage.cumulativeTokens,
            ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
            ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          }),
        );
      }

      const raw = record(usageValue);
      const usedTokens = finiteNonNegative(raw?.context_used);
      const capacityTokens = finiteNonNegative(raw?.context_max);
      const usedPercentage = finiteNonNegative(raw?.context_percent);
      if (usedTokens !== undefined || capacityTokens !== undefined || usedPercentage !== undefined) {
        const validPercentage = usedPercentage !== undefined && usedPercentage <= 100;
        updates.push(
          upsert('context', 'root', {
            kind: 'context',
            ...(usedTokens !== undefined ? { usedTokens } : {}),
            ...(capacityTokens !== undefined && capacityTokens > 0 ? { capacityTokens } : {}),
            ...(validPercentage ? { usedPercentage } : {}),
            percentageSource: validPercentage
              ? 'provider'
              : usedTokens !== undefined && capacityTokens !== undefined && capacityTokens > 0
                ? 'derived'
                : 'unavailable',
          }),
        );
      }

      if (usage.compressions !== undefined) {
        if (this.lastCompressionCount !== undefined && usage.compressions > this.lastCompressionCount) {
          updates.push(
            upsert('compaction', `counter:${usage.compressions}`, {
              kind: 'compaction',
              active: false,
              trigger: 'provider-counter',
            }),
          );
          quality = quality === 'exact' ? 'strong' : quality;
        }
        this.lastCompressionCount = Math.max(this.lastCompressionCount ?? 0, usage.compressions);
      }
    };

    switch (nativeType) {
      case 'gateway.ready':
        return null;

      case 'session.info': {
        const model = modelCard(payload.provider, payload.model);
        if (model) {
          updates.push(upsert('model', 'observed:root', { kind: 'model', providerModelId: model, intent: 'observed' }));
        }
        if ('reasoning_effort' in payload) {
          updates.push(
            upsert('effort', 'observed:root', {
              kind: 'effort',
              value: text(payload.reasoning_effort) ?? 'provider-default',
              intent: 'observed',
            }),
          );
          quality = 'strong';
        }
        const approvalMode = text(payload.approval_mode);
        const rawMode = payload.yolo === true ? 'yolo' : approvalMode;
        if (rawMode) {
          updates.push(
            upsert('mode', 'provider-permission-observed', {
              kind: 'mode',
              modeKind: 'provider-permission',
              raw: rawMode,
              normalized: rawMode === 'yolo' || rawMode === 'off' ? 'auto' : rawMode,
              intent: 'observed',
            }),
          );
        }
        const cwd = text(payload.cwd);
        if (cwd) updates.push(upsert('environment', 'root', { kind: 'environment', cwd }));
        if (payload.running === true) {
          updates.push(
            upsert('status', 'root-activity', {
              kind: 'activity',
              activityKind: 'responding',
              active: true,
              line: 'Working',
              since: observedAt,
            }),
          );
        } else if (payload.running === false) {
          updates.push(retract('status', 'root-activity'));
        }
        appendUsage(payload.usage);
        break;
      }

      case 'message.start':
      case 'message.delta':
      case 'thinking.delta':
        updates.push(
          upsert('status', 'root-activity', {
            kind: 'activity',
            activityKind: 'responding',
            active: true,
            line: nativeType === 'thinking.delta' ? 'Thinking' : 'Responding',
            since: observedAt,
          }),
        );
        break;

      case 'message.complete':
        updates.push(retract('status', 'root-activity'));
        appendUsage(payload.usage);
        if (this.compactionActive) {
          this.compactionActive = false;
          updates.push(upsert('compaction', 'root', { kind: 'compaction', active: false, trigger: 'turn-settled' }));
        }
        for (const [interactionId, kind] of this.pendingQuestions) {
          updates.push(
            upsert('status', `question:${interactionId}`, {
              kind: 'interaction',
              interactionId,
              interactionKind: kind,
              state: 'resolved',
            }),
          );
        }
        if (this.pendingQuestions.size > 0) quality = 'strong';
        this.pendingQuestions.clear();
        for (const interactionId of this.pendingPermissions.values()) {
          updates.push(
            upsert('status', `permission:${interactionId}`, {
              kind: 'interaction',
              interactionId,
              interactionKind: 'permission',
              state: 'resolved',
            }),
          );
        }
        if (this.uncorrelatedPermission) {
          updates.push(
            upsert('status', `permission:${this.uncorrelatedPermission}`, {
              kind: 'interaction',
              interactionId: this.uncorrelatedPermission,
              interactionKind: 'permission',
              state: 'resolved',
            }),
          );
        }
        if (this.pendingPermissions.size > 0 || this.uncorrelatedPermission) quality = 'strong';
        this.pendingPermissions.clear();
        this.uncorrelatedPermission = undefined;
        break;

      case 'status.update': {
        const kind = text(payload.kind);
        const line = text(payload.text) ?? kind ?? 'Working';
        const compacting = kind === 'compacting';
        updates.push(
          upsert('status', 'root-activity', {
            kind: 'activity',
            activityKind: compacting ? 'compacting' : 'other',
            active: true,
            line,
            since: observedAt,
          }),
        );
        if (compacting) {
          this.compactionActive = true;
          updates.push(upsert('compaction', 'root', { kind: 'compaction', active: true, trigger: 'status-update' }));
        }
        quality = 'strong';
        break;
      }

      case 'tool.start': {
        const toolId = text(payload.tool_id) ?? digest(payload);
        const toolName = text(payload.name) ?? 'tool';
        this.activeTools.delete(toolId);
        this.activeTools.set(toolId, toolName);
        while (this.activeTools.size > MAX_INTERACTIONS) {
          const oldest = this.activeTools.keys().next().value as string | undefined;
          if (!oldest) break;
          this.activeTools.delete(oldest);
        }
        updates.push(
          upsert('status', `tool:${toolId}`, {
            kind: 'activity',
            activityKind: 'tool',
            active: true,
            line: `Using ${toolName}`,
            since: observedAt,
          }),
        );
        break;
      }

      case 'tool.complete': {
        const toolId = text(payload.tool_id) ?? digest(payload);
        const toolName = text(payload.name);
        this.activeTools.delete(toolId);
        updates.push(retract('status', `tool:${toolId}`));
        const pendingPermission = this.pendingPermissions.get(toolId);
        if (pendingPermission) {
          updates.push(
            upsert('status', `permission:${pendingPermission}`, {
              kind: 'interaction',
              interactionId: pendingPermission,
              interactionKind: 'permission',
              state: 'resolved',
            }),
          );
          this.pendingPermissions.delete(toolId);
          quality = 'strong';
        }
        if (toolName === 'clarify' && this.pendingQuestions.size > 0) {
          for (const [interactionId, kind] of this.pendingQuestions) {
            updates.push(
              upsert('status', `question:${interactionId}`, {
                kind: 'interaction',
                interactionId,
                interactionKind: kind,
                state: 'resolved',
              }),
            );
          }
          this.pendingQuestions.clear();
          quality = 'strong';
        }
        break;
      }

      case 'approval.request': {
        const correlatedToolId =
          text(payload.tool_id) ?? text(payload.tool_call_id) ?? [...this.activeTools.keys()].at(-1);
        const interactionId =
          text(payload.request_id) ?? correlatedToolId ?? `approval:${eventSessionId(frame) ?? 'root'}`;
        if (correlatedToolId) this.pendingPermissions.set(correlatedToolId, interactionId);
        else this.uncorrelatedPermission = interactionId;
        updates.push(
          upsert('status', `permission:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: 'permission',
            state: 'pending',
            permission: {
              requestId: interactionId,
              ...(text(payload.name)
                ? { tool: text(payload.name)! }
                : text(payload.command)
                  ? { tool: 'terminal' }
                  : {}),
            },
          }),
        );
        break;
      }

      case 'clarify.request': {
        const questions = hermesStructuredQuestions(payload);
        const interactionId = text(payload.request_id);
        if (!questions || !interactionId) break;
        const choices = questions.some((question) => (question.options?.length ?? 0) > 0);
        const kind = choices ? ('mixed' as const) : ('free-form' as const);
        this.retainQuestion(interactionId, kind);
        updates.push(
          upsert('status', `question:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: kind,
            state: 'pending',
            questions,
          }),
        );
        quality = 'strong';
        break;
      }

      case 'clarify.expire': {
        const interactionId = text(payload.request_id);
        if (!interactionId) break;
        const kind = this.pendingQuestions.get(interactionId) ?? 'mixed';
        this.pendingQuestions.delete(interactionId);
        updates.push(
          upsert('status', `question:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: kind,
            state: 'cancelled',
          }),
        );
        quality = 'strong';
        break;
      }

      case 'subagent.spawn_requested':
      case 'subagent.start':
      case 'subagent.thinking':
      case 'subagent.tool':
      case 'subagent.progress':
      case 'subagent.complete': {
        actor = this.actor(payload);
        if (!actor) break;
        const stopped = nativeType === 'subagent.complete';
        const activity =
          nativeType === 'subagent.spawn_requested'
            ? 'Spawn requested'
            : nativeType === 'subagent.thinking'
              ? 'Thinking'
              : nativeType === 'subagent.tool'
                ? `Using ${text(payload.tool_name) ?? 'tool'}`
                : nativeType === 'subagent.progress'
                  ? (text(payload.text) ?? 'Working')
                  : nativeType === 'subagent.start'
                    ? (text(payload.goal) ?? 'Working')
                    : undefined;
        updates.push(
          upsert('delegation', `actor:${actor.runKey}`, {
            kind: 'actor',
            actor,
            state: stopped ? 'stopped' : nativeType === 'subagent.spawn_requested' ? 'unknown' : 'active',
            ...(!stopped && activity ? { activity } : {}),
          }),
        );
        const model = text(payload.model) ?? this.children.get(actor.nativeAgentId ?? '')?.model;
        if (model) {
          updates.push(
            upsert('model', `observed:${actor.runKey}`, {
              kind: 'model',
              actor,
              providerModelId: model,
              intent: 'observed',
            }),
          );
        }
        if (stopped) {
          const inputTokens = finiteNonNegative(payload.input_tokens);
          const outputTokens = finiteNonNegative(payload.output_tokens);
          const reasoningTokens = finiteNonNegative(payload.reasoning_tokens);
          if (inputTokens !== undefined || outputTokens !== undefined || reasoningTokens !== undefined) {
            const cumulativeTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0);
            const usageId = `hermes-child:${actor.runKey}:${cumulativeTokens}:${digest(payload)}`;
            updates.push(
              upsert('usage', usageId, {
                kind: 'usage',
                origin: 'protocol',
                usageId,
                actor,
                boundary: 'sample',
                canonical: false,
                cumulativeTokens,
                ...(inputTokens !== undefined ? { inputTokens } : {}),
                ...(outputTokens !== undefined ? { outputTokens } : {}),
              }),
            );
          }
        }
        quality = 'strong';
        break;
      }
    }

    if (updates.length === 0) return null;
    return this.batch(nativeType.replaceAll('.', '-'), observedAt, updates, {
      phase,
      quality,
      actor,
      evidence: this.evidence(frame, nativeType),
    });
  }

  railUnavailableBatch(
    observedAt: string,
    reason = 'Hermes gateway observation unavailable',
  ): AdapterMonitorObservationBatch {
    const capabilities = HERMES_MONITOR_CAPABILITIES.map((capability) =>
      capability.support === 'unsupported'
        ? capability
        : {
            ...capability,
            support: 'degraded' as const,
            limitations: [...capability.limitations, `${reason}; native TUI host liveness is unchanged.`],
          },
    );
    const coverage: ObservationCoverage[] = HERMES_MONITOR_CAPABILITIES.filter(
      ({ support }) => support !== 'unsupported',
    ).map(({ family }) => ({ family, completeness: 'unavailable', asOf: observedAt, reason }));
    return this.batch('rail-unavailable', observedAt, [], {
      quality: 'unknown',
      completeness: 'unavailable',
      readiness: 'degraded',
      capabilities,
      coverage,
      evidence: [{ namespace: 'hermes:tui-gateway-rail', id: `unavailable:${this.sequence + 1}` }],
    });
  }

  railReadyBatch(observedAt: string): AdapterMonitorObservationBatch {
    const coverage: ObservationCoverage[] = HERMES_MONITOR_CAPABILITIES.filter(
      ({ support }) => support !== 'unsupported',
    ).map(({ family }) => ({
      family,
      completeness: 'partial',
      asOf: observedAt,
      reason: 'Gateway reconnected without a verified durable event resync',
    }));
    return this.batch('rail-ready', observedAt, [], {
      // The gateway has no durable replay barrier. Preserve the last committed
      // facts and truthfully mark their new coverage partial instead of
      // presenting this reconnect as a complete replacement.
      phase: 'live',
      quality: 'unknown',
      completeness: 'partial',
      readiness: 'ready',
      capabilities: [...HERMES_MONITOR_CAPABILITIES],
      coverage,
      evidence: [{ namespace: 'hermes:tui-gateway-rail', id: `ready:${this.sequence + 1}` }],
    });
  }
}
