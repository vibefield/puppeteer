/** Codex app-server facts projected onto the correction-aware monitor SPI. */

import { randomUUID } from 'node:crypto';
import type { ActorRunRef, ContextWindowUpdatedEvent, MonitorMetricFamily } from '@vibecook/puppeteer-core';
import type {
  AdapterMonitorObservationBatch,
  EvidenceRef,
  MonitorFamilyUpdate,
  MonitorFamilyValueMap,
  ObservationCapability,
  ObservationCoverage,
} from '@vibecook/puppeteer-core/monitor-spi';
import type { CodexServerNotification } from './types.js';
import { CODEX_CONTRACT, CODEX_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

export { CODEX_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

const MAX_USAGE_SAMPLES = 256;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
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

function safeAtom(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const object = rec(value);
  if (!object) return undefined;
  const type = str(object.type);
  if (type) return type;
  if ('granular' in object) return 'granular';
  if ('custom' in object) return 'custom';
  return 'structured';
}

function permissionMode(approvalPolicy: unknown, sandboxPolicy: unknown): string | undefined {
  const approval = safeAtom(approvalPolicy);
  const sandbox = safeAtom(sandboxPolicy);
  if (!approval && !sandbox) return undefined;
  return [approval ? `approval:${approval}` : undefined, sandbox ? `sandbox:${sandbox}` : undefined]
    .filter((value): value is string => value !== undefined)
    .join('; ');
}

function collaborationMode(value: unknown): string | undefined {
  return str(value) ?? str(rec(value)?.mode);
}

function itemEvidenceId(method: string, params: Record<string, unknown>, sequence: number): string {
  const item = rec(params.item);
  return (
    str(item?.id) ?? str(params.itemId) ?? str(rec(params.turn)?.id) ?? str(params.turnId) ?? `${method}:${sequence}`
  );
}

function actorState(status: string | undefined): 'active' | 'idle' | 'stopped' | 'unknown' {
  switch (status) {
    case 'pendingInit':
    case 'running':
    case 'active':
    case 'inProgress':
      return 'active';
    case 'idle':
      return 'idle';
    case 'interrupted':
    case 'completed':
    case 'errored':
    case 'shutdown':
    case 'notFound':
    case 'closed':
      return 'stopped';
    default:
      return 'unknown';
  }
}

function childActivity(itemType: string | undefined): { kind: 'responding' | 'reasoning' | 'tool'; line: string } {
  if (itemType === 'reasoning') return { kind: 'reasoning', line: 'Subagent reasoning' };
  if (itemType === 'agentMessage' || itemType === 'userMessage') {
    return { kind: 'responding', line: 'Subagent responding' };
  }
  return { kind: 'tool', line: 'Subagent using a tool' };
}

export interface CodexMonitorEvidenceOptions {
  nativeSessionId: () => string | undefined;
  modelDisplayName?: (modelId: string) => string | undefined;
  epoch?: string;
}

export interface CodexConfiguredIntent {
  model?: string;
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
}

/** Stateful app-server projector. Raw provider payloads remain on normalized candidates. */
export class CodexMonitorEvidence {
  private readonly epoch: string;
  private sequence = 0;
  private usageSequence = 0;
  private readonly usageKeysByScope = new Map<string, string[]>();
  private readonly childParents = new Map<string, string>();
  private readonly childRoles = new Map<string, string | undefined>();

  constructor(private readonly options: CodexMonitorEvidenceOptions) {
    this.epoch = options.epoch ?? `app-server:${randomUUID()}`;
  }

  private rootSessionId(): string | undefined {
    return this.options.nativeSessionId() || undefined;
  }

  private actor(threadId: string): ActorRunRef | undefined {
    const rootSessionId = this.rootSessionId();
    const parentThreadId = this.childParents.get(threadId);
    if (!rootSessionId || !parentThreadId) return undefined;
    return {
      rootSessionKey: rootSessionId,
      runKey: `${rootSessionId}:codex-thread:${threadId}`,
      role: 'child',
      parentRunKey:
        parentThreadId === rootSessionId ? `${rootSessionId}:root` : `${rootSessionId}:codex-thread:${parentThreadId}`,
      nativeSessionId: threadId,
      nativeAgentId: threadId,
      ...(this.childRoles.get(threadId) ? { nativeAgentType: this.childRoles.get(threadId) } : {}),
    };
  }

  private registerChild(threadId: string, parentThreadId: string, role?: string): ActorRunRef | undefined {
    const rootSessionId = this.rootSessionId();
    if (!rootSessionId || threadId === rootSessionId) return undefined;
    if (parentThreadId !== rootSessionId && !this.childParents.has(parentThreadId)) return undefined;
    if (!this.childParents.has(threadId)) this.childParents.set(threadId, parentThreadId);
    if (role) this.childRoles.set(threadId, role);
    return this.actor(threadId);
  }

  private isObservedThread(threadId: string | undefined): boolean {
    const rootSessionId = this.rootSessionId();
    return threadId !== undefined && (threadId === rootSessionId || this.childParents.has(threadId));
  }

  private evidence(id: string): EvidenceRef[] {
    return [{ namespace: 'codex:app-server', id }];
  }

  private batch(
    label: string,
    observedAt: string,
    updates: MonitorFamilyUpdate[],
    options: {
      phase?: AdapterMonitorObservationBatch['phase'];
      quality?: AdapterMonitorObservationBatch['quality'];
      completeness?: AdapterMonitorObservationBatch['completeness'];
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
        id: 'codex:app-server-monitor',
        epoch: this.epoch,
        sequence: this.sequence,
        contractVersion: CODEX_CONTRACT,
      },
      phase: options.phase ?? 'live',
      observedAt,
      quality: options.quality ?? 'exact',
      completeness: options.completeness ?? 'partial',
      provisional: false,
      readiness: options.readiness ?? 'ready',
      ...(this.rootSessionId() ? { scope: { nativeSessionId: this.rootSessionId() } } : {}),
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
      capabilities: [...CODEX_MONITOR_CAPABILITIES],
    });
  }

  /** Initial thread/start, thread/resume, or thread/read response. */
  bootstrapResponseBatch(
    responseValue: unknown,
    observedAt: string,
    evidenceId: string,
    configured: CodexConfiguredIntent = {},
  ): AdapterMonitorObservationBatch | null {
    const response = rec(responseValue);
    const thread = rec(response?.thread);
    const threadId = str(thread?.id) ?? str(thread?.sessionId);
    const parentThreadId = str(thread?.parentThreadId);
    const role = str(thread?.agentRole);
    const actor = threadId && parentThreadId ? this.registerChild(threadId, parentThreadId, role) : undefined;
    const root = !actor;
    const updates: MonitorFamilyUpdate[] = [];

    const cwd = str(response?.cwd) ?? str(thread?.cwd);
    if (root && cwd) updates.push(upsert('environment', 'root', { kind: 'environment', cwd }));

    if (configured.model && root) {
      updates.push(
        upsert('model', 'configured', {
          kind: 'model',
          providerModelId: configured.model,
          ...(this.options.modelDisplayName?.(configured.model)
            ? { displayName: this.options.modelDisplayName(configured.model) }
            : {}),
          intent: 'configured',
        }),
      );
    }
    const modelId = str(response?.model);
    if (modelId) {
      updates.push(
        upsert('model', actor ? `actor:${actor.runKey}` : 'observed', {
          kind: 'model',
          ...(actor ? { actor } : {}),
          providerModelId: modelId,
          ...(this.options.modelDisplayName?.(modelId) ? { displayName: this.options.modelDisplayName(modelId) } : {}),
          intent: 'observed',
        }),
      );
    }

    const effort = str(response?.reasoningEffort) ?? str(response?.effort);
    if (effort) {
      updates.push(
        upsert('effort', actor ? `actor:${actor.runKey}` : 'observed', {
          kind: 'effort',
          ...(actor ? { actor } : {}),
          value: effort,
          intent: 'observed',
        }),
      );
    }

    if (actor) {
      updates.push(upsert('delegation', `actor:${actor.runKey}`, { kind: 'actor', actor, state: 'idle' }));
    } else {
      const configuredPermission = permissionMode(configured.approvalPolicy, configured.sandboxPolicy);
      if (configuredPermission) {
        updates.push(
          upsert('mode', 'provider-permission-configured', {
            kind: 'mode',
            modeKind: 'provider-permission',
            raw: configuredPermission,
            intent: 'configured',
          }),
        );
      }
      const observedPermission = permissionMode(response?.approvalPolicy, response?.sandboxPolicy ?? response?.sandbox);
      if (observedPermission) {
        updates.push(
          upsert('mode', 'provider-permission-observed', {
            kind: 'mode',
            modeKind: 'provider-permission',
            raw: observedPermission,
            intent: 'observed',
          }),
        );
      }
      const sessionMode = collaborationMode(response?.collaborationMode);
      if (sessionMode) {
        updates.push(
          upsert('mode', 'provider-session-observed', {
            kind: 'mode',
            modeKind: 'provider-session',
            raw: sessionMode,
            intent: 'observed',
          }),
        );
      }
    }

    if (updates.length === 0) return null;
    return this.batch('thread-response', observedAt, updates, {
      phase: 'bootstrap',
      completeness: 'complete',
      evidence: this.evidence(evidenceId),
    });
  }

  /** Rollout-tail fallback supplies context only; it is never billed burn. */
  contextBootstrapBatch(
    context: ContextWindowUpdatedEvent,
    observedAt: string,
    evidenceId: string,
  ): AdapterMonitorObservationBatch {
    return this.batch(
      'rollout-context',
      observedAt,
      [
        upsert('context', 'root', {
          kind: 'context',
          usedTokens: context.usedTokens,
          capacityTokens: context.capacityTokens,
          ...(context.usedPercentage !== undefined ? { usedPercentage: context.usedPercentage } : {}),
          percentageSource: context.usedPercentage !== undefined ? (context.percentageSource ?? 'provider') : 'derived',
        }),
      ],
      {
        phase: 'bootstrap',
        quality: 'strong',
        evidence: [{ namespace: 'codex:rollout-tail', id: evidenceId }],
      },
    );
  }

  notificationBatch(
    notification: CodexServerNotification,
    observedAt: string,
    phase: 'bootstrap' | 'live' = 'live',
  ): AdapterMonitorObservationBatch | null {
    const method = notification.method;
    const params = notification.params ?? {};
    const thread = rec(params.thread);
    const notificationThreadId = str(params.threadId) ?? str(thread?.id);
    const parentThreadId = str(thread?.parentThreadId);
    if (method === 'thread/started' && notificationThreadId && parentThreadId) {
      this.registerChild(notificationThreadId, parentThreadId, str(thread?.agentRole));
    }
    if (!this.isObservedThread(notificationThreadId)) return null;

    const actor = notificationThreadId ? this.actor(notificationThreadId) : undefined;
    const root = !actor;
    const updates: MonitorFamilyUpdate[] = [];
    let quality: AdapterMonitorObservationBatch['quality'] = 'exact';

    switch (method) {
      case 'thread/started': {
        if (actor) {
          const status = str(rec(thread?.status)?.type);
          updates.push(
            upsert('delegation', `actor:${actor.runKey}`, {
              kind: 'actor',
              actor,
              state: actorState(status),
            }),
          );
          quality = 'strong';
        } else {
          const cwd = str(thread?.cwd);
          if (cwd) updates.push(upsert('environment', 'root', { kind: 'environment', cwd }));
        }
        break;
      }

      case 'thread/status/changed': {
        if (!actor) break;
        const status = str(rec(params.status)?.type);
        updates.push(
          upsert('delegation', `actor:${actor.runKey}`, {
            kind: 'actor',
            actor,
            state: actorState(status),
          }),
        );
        quality = 'strong';
        break;
      }

      case 'thread/closed':
        if (actor) {
          updates.push(upsert('delegation', `actor:${actor.runKey}`, { kind: 'actor', actor, state: 'stopped' }));
          quality = 'strong';
        }
        break;

      case 'thread/tokenUsage/updated': {
        const usage = rec(params.tokenUsage);
        const total = rec(usage?.total);
        const last = rec(usage?.last);
        const cumulativeTokens = finiteNonNegative(total?.totalTokens);
        const usedTokens = finiteNonNegative(last?.totalTokens);
        const capacityTokens = finiteNonNegative(usage?.modelContextWindow);
        const metricKey = actor ? `actor:${actor.runKey}` : 'root';
        if (cumulativeTokens !== undefined) {
          this.usageSequence += 1;
          const usageKey = `sample:${notificationThreadId}:${this.usageSequence}`;
          const usageKeys = this.usageKeysByScope.get(metricKey) ?? [];
          usageKeys.push(usageKey);
          this.usageKeysByScope.set(metricKey, usageKeys);
          updates.push(
            upsert('usage', usageKey, {
              kind: 'usage',
              usageId: usageKey,
              ...(actor ? { actor } : {}),
              boundary: 'sample',
              canonical: false,
              cumulativeTokens,
            }),
          );
          while (usageKeys.length > MAX_USAGE_SAMPLES) {
            const removed = usageKeys.shift();
            if (removed) updates.push(retract('usage', removed));
          }
        }
        if (usedTokens !== undefined && capacityTokens !== undefined) {
          updates.push(
            upsert('context', metricKey, {
              kind: 'context',
              ...(actor ? { actor } : {}),
              usedTokens,
              capacityTokens,
              percentageSource: 'derived',
            }),
          );
        } else if (usage && usage.modelContextWindow === null) {
          updates.push(retract('context', metricKey));
        }
        break;
      }

      case 'thread/settings/updated': {
        const settings = rec(params.threadSettings) ?? params;
        const metricKey = actor ? `actor:${actor.runKey}` : 'observed';
        const cwd = str(settings.cwd);
        if (root && cwd) updates.push(upsert('environment', 'root', { kind: 'environment', cwd }));
        const modelId = str(settings.model);
        if (modelId) {
          updates.push(
            upsert('model', metricKey, {
              kind: 'model',
              ...(actor ? { actor } : {}),
              providerModelId: modelId,
              ...(this.options.modelDisplayName?.(modelId)
                ? { displayName: this.options.modelDisplayName(modelId) }
                : {}),
              intent: 'observed',
            }),
          );
        }
        if ('effort' in settings) {
          const effort = str(settings.effort);
          if (effort) {
            updates.push(
              upsert('effort', metricKey, {
                kind: 'effort',
                ...(actor ? { actor } : {}),
                value: effort,
                intent: 'observed',
              }),
            );
          } else {
            updates.push(retract('effort', metricKey));
          }
        }
        if (root) {
          const sessionMode = collaborationMode(settings.collaborationMode);
          if (sessionMode) {
            updates.push(
              upsert('mode', 'provider-session-observed', {
                kind: 'mode',
                modeKind: 'provider-session',
                raw: sessionMode,
                intent: 'observed',
              }),
            );
          }
          const permission = permissionMode(settings.approvalPolicy, settings.sandboxPolicy ?? settings.sandbox);
          if (permission) {
            updates.push(
              upsert('mode', 'provider-permission-observed', {
                kind: 'mode',
                modeKind: 'provider-permission',
                raw: permission,
                intent: 'observed',
              }),
            );
          }
        }
        break;
      }

      case 'model/rerouted': {
        const modelId = str(params.toModel);
        const metricKey = actor ? `actor:${actor.runKey}` : 'observed';
        if (modelId) {
          updates.push(
            upsert('model', metricKey, {
              kind: 'model',
              ...(actor ? { actor } : {}),
              providerModelId: modelId,
              ...(this.options.modelDisplayName?.(modelId)
                ? { displayName: this.options.modelDisplayName(modelId) }
                : {}),
              intent: 'observed',
            }),
          );
        }
        updates.push(retract('context', actor ? `actor:${actor.runKey}` : 'root'));
        break;
      }

      case 'turn/plan/updated': {
        const plan = Array.isArray(params.plan) ? params.plan : undefined;
        if (!plan) break;
        const key = actor ? `actor:${actor.runKey}` : 'root';
        const steps = plan.flatMap((value) => {
          const step = rec(value);
          const text = str(step?.step);
          const status = str(step?.status);
          return text && status ? [{ text, status }] : [];
        });
        if (steps.length === 0) updates.push(retract('planning', `plan:${key}`));
        else {
          updates.push(
            upsert('planning', `plan:${key}`, {
              kind: 'plan',
              planId: `codex-plan:${key}`,
              ...(actor ? { actor } : {}),
              steps,
              provisional: false,
            }),
          );
        }
        quality = 'strong';
        break;
      }

      case 'turn/started':
        if (actor) {
          updates.push(
            upsert('delegation', `actor:${actor.runKey}`, { kind: 'actor', actor, state: 'active' }),
            upsert('status', `child-turn:${actor.runKey}`, {
              kind: 'activity',
              activityKind: 'responding',
              active: true,
              line: 'Subagent turn running',
              actor,
            }),
          );
          quality = 'strong';
        }
        break;

      case 'turn/completed':
        if (actor) {
          updates.push(
            upsert('delegation', `actor:${actor.runKey}`, { kind: 'actor', actor, state: 'idle' }),
            upsert('status', `child-turn:${actor.runKey}`, {
              kind: 'activity',
              activityKind: 'responding',
              active: false,
              actor,
            }),
          );
          quality = 'strong';
        }
        break;

      case 'item/started':
      case 'item/completed': {
        const item = rec(params.item);
        const itemType = str(item?.type);
        const started = method === 'item/started';
        if (itemType === 'contextCompaction' && root) {
          updates.push(
            upsert('compaction', 'root', {
              kind: 'compaction',
              active: started,
              trigger: str(item?.id),
            }),
          );
          if (!started) updates.push(retract('context', 'root'));
          quality = 'strong';
          break;
        }
        if (itemType === 'collabAgentToolCall') {
          const senderThreadId = str(item?.senderThreadId) ?? notificationThreadId;
          const receiverThreadIds = Array.isArray(item?.receiverThreadIds)
            ? item.receiverThreadIds.filter((value): value is string => typeof value === 'string')
            : [];
          const states = rec(item?.agentsStates) ?? {};
          const childIds = new Set([...receiverThreadIds, ...Object.keys(states)]);
          for (const childId of childIds) {
            if (!senderThreadId) continue;
            const child = this.registerChild(childId, senderThreadId);
            if (!child) continue;
            const nativeState = rec(states[childId]);
            const recordedState = actorState(str(nativeState?.status));
            // A replayed collaboration item says what the child was doing at
            // that old tool call, not whether it is running after a restart.
            const state = phase === 'bootstrap' && recordedState === 'active' ? 'unknown' : recordedState;
            const fallbackState = str(item?.status) === 'failed' || phase === 'bootstrap' ? 'unknown' : 'active';
            updates.push(
              upsert('delegation', `actor:${child.runKey}`, {
                kind: 'actor',
                actor: child,
                state: state === 'unknown' ? fallbackState : state,
              }),
            );
            const modelId = str(item?.model);
            if (str(item?.tool) === 'spawnAgent' && modelId) {
              updates.push(
                upsert('model', `actor:${child.runKey}`, {
                  kind: 'model',
                  actor: child,
                  providerModelId: modelId,
                  ...(this.options.modelDisplayName?.(modelId)
                    ? { displayName: this.options.modelDisplayName(modelId) }
                    : {}),
                  intent: 'configured',
                }),
              );
            }
            const effort = str(item?.reasoningEffort);
            if (str(item?.tool) === 'spawnAgent' && effort) {
              updates.push(
                upsert('effort', `actor:${child.runKey}`, {
                  kind: 'effort',
                  actor: child,
                  value: effort,
                  intent: 'configured',
                }),
              );
            }
          }
          quality = 'strong';
          break;
        }
        if (itemType === 'subAgentActivity') {
          const childId = str(item?.agentThreadId);
          if (childId && notificationThreadId) {
            const child = this.registerChild(childId, notificationThreadId);
            if (child) {
              const kind = str(item?.kind);
              const active = kind !== 'interrupted' && phase === 'live';
              updates.push(
                upsert('delegation', `actor:${child.runKey}`, {
                  kind: 'actor',
                  actor: child,
                  state: kind === 'interrupted' ? 'stopped' : active ? 'active' : 'unknown',
                  ...(active ? { activity: kind === 'interacted' ? 'Subagent interacted' : 'Subagent started' } : {}),
                }),
              );
            }
          }
          quality = 'strong';
          break;
        }
        if (actor && itemType) {
          const activity = childActivity(itemType);
          const itemId = str(item?.id) ?? 'unknown-item';
          updates.push(
            upsert('delegation', `actor:${actor.runKey}`, {
              kind: 'actor',
              actor,
              state: started ? 'active' : 'idle',
              ...(started ? { activity: activity.line } : {}),
            }),
            upsert('status', `child-item:${actor.runKey}:${itemId}`, {
              kind: 'activity',
              activityKind: activity.kind,
              active: started,
              ...(started ? { line: activity.line } : {}),
              actor,
            }),
          );
          quality = 'strong';
        }
        break;
      }

      case 'thread/compacted':
        if (root) {
          updates.push(
            upsert('compaction', 'root', { kind: 'compaction', active: false, trigger: 'thread/compacted' }),
            retract('context', 'root'),
          );
          quality = 'strong';
        }
        break;

      default:
        break;
    }

    if (updates.length === 0) return null;
    const nextSequence = this.sequence + 1;
    return this.batch(method.replaceAll('/', '-'), observedAt, updates, {
      phase,
      quality,
      evidence: this.evidence(itemEvidenceId(method, params, nextSequence)),
    });
  }

  /** Observation/control rail loss degrades evidence; it never claims host-process death. */
  railUnavailableBatch(observedAt: string, reason: string): AdapterMonitorObservationBatch {
    const capabilities = CODEX_MONITOR_CAPABILITIES.map((capability) =>
      capability.support === 'unsupported'
        ? capability
        : {
            ...capability,
            support: 'degraded' as const,
            limitations: [...capability.limitations, `Observation rail unavailable: ${reason}`],
          },
    );
    const coverage: ObservationCoverage[] = CODEX_MONITOR_CAPABILITIES.filter(
      ({ support }) => support !== 'unsupported',
    ).map(({ family }) => ({
      family,
      completeness: 'unavailable',
      asOf: observedAt,
      reason: 'codex app-server observation rail unavailable',
    }));
    return this.batch('rail-unavailable', observedAt, [], {
      quality: 'unknown',
      completeness: 'unavailable',
      readiness: 'degraded',
      evidence: [{ namespace: 'codex:app-server-control', id: `rail-unavailable:${this.sequence + 1}` }],
      capabilities,
      coverage,
    });
  }
}
