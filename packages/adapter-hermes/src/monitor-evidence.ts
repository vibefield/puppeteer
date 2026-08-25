/** Hermes 0.20.0 tui_gateway facts projected onto the evidence-backed monitor SPI. */

import { createHash, randomUUID } from 'node:crypto';
import type { ActorRunRef, MonitorMetricFamily } from '@vibecook/chopsticks-core';
import type {
  AdapterMonitorObservationBatch,
  EvidenceRef,
  MonitorFamilyUpdate,
  MonitorFamilyValueMap,
  ObservationCapability,
  ObservationCoverage,
} from '@vibecook/chopsticks-core/monitor-spi';
import { hermesStructuredQuestions } from './questions.js';
import { eventType, type HermesGatewayFrame } from './transport/jsonrpc.js';

const HERMES_CONTRACT = 'hermes@0.20.0:tui-gateway';
const MAX_TEXT_LENGTH = 4_096;
const MAX_USAGE_IDENTITIES = 1_024;
const MAX_INTERACTIONS = 256;

/**
 * Runtime-verified claims come from the promoted 0.20.0 captures. Claims for
 * context, todos, clarification, compaction, and subagents are deliberately
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
    family: 'planning',
    support: 'degraded',
    actorScope: 'root',
    latency: 'response',
    source: 'hermes-tool-complete-todo-snapshot',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'tool.complete carries the authoritative full todo list only when Hermes tool lifecycle display is enabled.',
      'The todo branch is exact-release-source-backed but not pinned-runtime captured.',
      'Stable task lifecycle is reported only for todo entries that carry native IDs.',
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
      'Hermes exposes no verified agent-team identity or membership contract.',
    ],
  },
  {
    family: 'workflow',
    support: 'unsupported',
    actorScope: 'session',
    latency: 'historical',
    source: 'none-in-hermes-tui-gateway-0.20.0',
    contractVersion: HERMES_CONTRACT,
    limitations: [
      'Goals, background prompts, cron jobs, kanban items, and delegations have no shared verified workflow-run identity.',
      'No bounded workflow-definition artifact contract exists on the side-observation rail.',
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

function replace<F extends MonitorMetricFamily>(
  family: F,
  values: Array<{ key: string; value: MonitorFamilyValueMap[F] }>,
): MonitorFamilyUpdate {
  return { family, operation: 'replace', values, coverage: 'complete' } as MonitorFamilyUpdate;
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

function todoStatus(value: unknown): 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled' | 'unknown' {
  switch (text(value)?.toLowerCase()) {
    case 'pending':
    case 'not_started':
    case 'todo':
      return 'pending';
    case 'in_progress':
    case 'running':
    case 'active':
      return 'in-progress';
    case 'done':
    case 'completed':
    case 'complete':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'unknown';
  }
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
  epoch?: string;
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
      phase?: AdapterMonitorObservationBatch['phase'];
      quality?: AdapterMonitorObservationBatch['quality'];
      completeness?: AdapterMonitorObservationBatch['completeness'];
      provisional?: boolean;
      readiness?: AdapterMonitorObservationBatch['readiness'];
      actor?: ActorRunRef;
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
    let completeness: AdapterMonitorObservationBatch['completeness'] = 'partial';

    const appendUsage = (usageValue: unknown): void => {
      const usage = usageSnapshot(usageValue);
      if (!usage) return;
      const identity = `root:${usage.calls ?? 'unknown'}:${usage.cumulativeTokens}:${digest(usage)}`;
      if (this.retainUsageIdentity(identity)) {
        const usageId = `hermes-sample:${this.options.nativeSessionId()}:${identity}`;
        updates.push(
          upsert('usage', usageId, {
            kind: 'usage',
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
        if (toolName?.toLowerCase().includes('todo') && Array.isArray(payload.todos)) {
          const steps: Array<{ text: string; status: string }> = [];
          const values: Array<{ key: string; value: MonitorFamilyValueMap['planning'] }> = [];
          for (const candidate of payload.todos) {
            const todo = record(candidate);
            const description = text(todo?.content ?? todo?.title ?? todo?.text);
            if (!description) continue;
            const providerStatus = text(todo?.status) ?? 'unknown';
            steps.push({ text: description, status: providerStatus });
            const taskId = text(todo?.id);
            if (taskId) {
              values.push({
                key: `task:${taskId}`,
                value: {
                  kind: 'task',
                  taskId,
                  description,
                  status: todoStatus(providerStatus),
                  providerStatus,
                  provisional: false,
                },
              });
            }
          }
          if (steps.length > 0) {
            values.unshift({
              key: 'plan:root',
              value: { kind: 'plan', planId: 'hermes-todos:root', steps, provisional: false },
            });
          }
          updates.push(replace('planning', values));
          quality = 'strong';
          completeness = 'complete';
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
      completeness,
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
