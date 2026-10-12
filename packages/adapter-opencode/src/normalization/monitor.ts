/** OpenCode 1.18.16 HTTP/SSE facts projected onto the evidence-backed monitor SPI. */

import { createHash, randomUUID } from 'node:crypto';
import type { ActorRunRef, AgentStructuredQuestion, MonitorMetricFamily } from '@vibefield/puppeteer-core';
import type {
  AdapterMonitorObservationBatch,
  EvidenceRef,
  MonitorFamilyUpdate,
  MonitorFamilyValueMap,
  ObservationCapability,
  ObservationCoverage,
} from '@vibefield/puppeteer-core/monitor-spi';
import type { OpenCodeModelSelection, OpenCodeSessionInfo } from '../transport/client.js';
import type { OpenCodeSseRecord } from '../transport/event-stream.js';
import { OPENCODE_CONTRACT, OPENCODE_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

export { OPENCODE_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

const MAX_TEXT_LENGTH = 4_096;
const MAX_QUESTIONS = 64;
const MAX_OPTIONS = 128;
const MAX_TRACKED_INTERACTIONS = 512;

const rec = (value: unknown): Record<string, unknown> | undefined =>
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

function modelCard(providerID: unknown, modelID: unknown): string | undefined {
  const model = text(modelID);
  if (!model) return undefined;
  const provider = text(providerID);
  return provider ? `${provider}/${model}` : model;
}

function recordSessionID(record: OpenCodeSseRecord): string | undefined {
  const info = rec(record.properties.info);
  const direct = text(record.properties.sessionID) ?? text(info?.sessionID);
  if (direct) return direct;
  if (['session.created', 'session.updated', 'session.deleted'].includes(record.type)) return text(info?.id);
  return undefined;
}

function effectiveAt(record: OpenCodeSseRecord): string | undefined {
  const info = rec(record.properties.info);
  const part = rec(record.properties.part);
  const infoTime = rec(info?.time);
  const partTime = rec(part?.time);
  for (const value of [
    record.properties.time,
    partTime?.end,
    partTime?.start,
    infoTime?.completed,
    infoTime?.updated,
    infoTime?.created,
  ]) {
    const milliseconds = finiteNonNegative(value);
    if (milliseconds !== undefined) return new Date(milliseconds).toISOString();
  }
  return undefined;
}

interface TokenUsage {
  deltaTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  const tokens = rec(value);
  if (!tokens) return undefined;
  const cache = rec(tokens.cache);
  const total = finiteNonNegative(tokens.total);
  const inputTokens = finiteNonNegative(tokens.input);
  const outputTokens = finiteNonNegative(tokens.output);
  const cacheReadTokens = finiteNonNegative(cache?.read);
  const cacheCreationTokens = finiteNonNegative(cache?.write);
  if (
    total === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined;
  }
  return {
    deltaTokens:
      total ?? (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
}

function usageUpdate(
  sessionID: string,
  messageID: string,
  tokens: unknown,
  actor?: ActorRunRef,
): MonitorFamilyUpdate | undefined {
  const usage = tokenUsage(tokens);
  if (!usage) return undefined;
  const usageId = `opencode-response:${sessionID}:${messageID}`;
  return upsert('usage', usageId, {
    kind: 'usage',
    origin: 'protocol',
    usageId,
    ...(actor ? { actor } : {}),
    boundary: 'response',
    canonical: true,
    ...usage,
  });
}

function boundedQuestions(value: unknown): AgentStructuredQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions = value.slice(0, MAX_QUESTIONS).flatMap((candidate, index) => {
    const question = rec(candidate);
    const prompt = text(question?.question);
    if (!prompt) return [];
    const options = Array.isArray(question?.options)
      ? question.options.slice(0, MAX_OPTIONS).flatMap((entry) => {
          const option = rec(entry);
          const label = text(option?.label);
          if (!label) return [];
          const description = text(option?.description);
          return [{ label, ...(description ? { description } : {}) }];
        })
      : [];
    const header = text(question?.header);
    return [
      {
        id: String(index),
        ...(header ? { header } : {}),
        prompt,
        ...(options.length > 0 ? { options } : {}),
        allowMultiple: question?.multiple === true,
        // OpenCode 1.18.16 documents an omitted `custom` flag as enabled.
        // Only an explicit false value makes the prompt choice-only.
        allowFreeForm: question?.custom !== false,
      },
    ];
  });
  return questions.length > 0 ? questions : undefined;
}

/** Shared bounded projection for normalized interaction events and monitor evidence. */
export function openCodeStructuredQuestions(value: unknown): AgentStructuredQuestion[] | undefined {
  return boundedQuestions(value);
}

function interactionKind(
  questions: readonly AgentStructuredQuestion[],
): 'choice' | 'multi-choice' | 'free-form' | 'mixed' {
  const choices = questions.some((question) => (question.options?.length ?? 0) > 0);
  const freeForm = questions.some((question) => question.allowFreeForm);
  if (choices && freeForm) return 'mixed';
  if (freeForm) return 'free-form';
  return questions.some((question) => question.allowMultiple) ? 'multi-choice' : 'choice';
}

export interface OpenCodeConfiguredIntent {
  cwd: string;
  agent?: string;
  model?: OpenCodeModelSelection;
}

export interface OpenCodeMonitorEvidenceOptions {
  nativeSessionId: () => string | undefined;
  contextWindowCapacityTokens?: number | undefined;
  epoch?: string | undefined;
}

interface PendingInteraction {
  actor?: ActorRunRef;
  kind: 'permission' | 'choice' | 'multi-choice' | 'free-form' | 'mixed';
}

/** Stateful only for native parentage and correction-safe producer ordering. */
export class OpenCodeMonitorEvidence {
  private readonly epoch: string;
  private sequence = 0;
  private readonly children = new Map<string, { agent?: string | undefined }>();
  private readonly interactions = new Map<string, PendingInteraction>();

  constructor(private readonly options: OpenCodeMonitorEvidenceOptions) {
    this.epoch = options.epoch ?? `opencode:${randomUUID()}`;
  }

  private root(): string | undefined {
    return this.options.nativeSessionId();
  }

  private actor(sessionID: string): ActorRunRef | undefined {
    const root = this.root();
    if (!root || sessionID === root || !this.children.has(sessionID)) return undefined;
    const child = this.children.get(sessionID);
    return {
      rootSessionKey: root,
      runKey: `${root}:actor:${sessionID}`,
      role: 'child',
      parentRunKey: `${root}:root`,
      nativeSessionId: sessionID,
      nativeAgentId: sessionID,
      ...(child?.agent ? { nativeAgentType: child.agent } : {}),
    };
  }

  private registerChild(sessionID: string, agent?: string): ActorRunRef | undefined {
    const root = this.root();
    if (!root || sessionID === root) return undefined;
    const existing = this.children.get(sessionID);
    this.children.set(sessionID, { ...((agent ?? existing?.agent) ? { agent: agent ?? existing?.agent } : {}) });
    return this.actor(sessionID);
  }

  private retainInteraction(id: string, interaction: PendingInteraction): void {
    this.interactions.delete(id);
    this.interactions.set(id, interaction);
    while (this.interactions.size > MAX_TRACKED_INTERACTIONS) {
      const oldest = this.interactions.keys().next().value as string | undefined;
      if (!oldest) return;
      this.interactions.delete(oldest);
    }
  }

  private evidence(record: OpenCodeSseRecord): EvidenceRef[] {
    return [
      {
        namespace: record.id.startsWith('history:') ? 'opencode:durable-http' : 'opencode:sse',
        id: record.id,
        revisionKey: digest(record.properties),
        ...(recordSessionID(record) ? { sourceObjectId: recordSessionID(record) } : {}),
      },
    ];
  }

  private batch(
    label: string,
    observedAt: string,
    updates: MonitorFamilyUpdate[],
    options: {
      phase?: AdapterMonitorObservationBatch['phase'] | undefined;
      effectiveAt?: string | undefined;
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
    const root = this.root();
    return {
      schemaVersion: 1,
      batchId: `${label}:${this.sequence}`,
      producer: {
        id: 'opencode:http-sse-monitor',
        epoch: this.epoch,
        sequence: this.sequence,
        contractVersion: OPENCODE_CONTRACT,
      },
      phase: options.phase ?? 'live',
      observedAt,
      ...(options.effectiveAt ? { effectiveAt: options.effectiveAt } : {}),
      quality: options.quality ?? 'exact',
      completeness: options.completeness ?? 'partial',
      provisional: options.provisional ?? false,
      // Resync batches build an invisible staged slice until railReadyBatch
      // supplies the explicit ready barrier.
      readiness: options.readiness ?? (options.phase === 'resync' ? 'loading' : 'ready'),
      ...(root
        ? { scope: { nativeSessionId: root, ...(options.actor ? { actorRunKey: options.actor.runKey } : {}) } }
        : {}),
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
      capabilities: [...OPENCODE_MONITOR_CAPABILITIES],
      evidence: [{ namespace: 'opencode:surface-contract', id: OPENCODE_CONTRACT }],
    });
  }

  configuredBatch(configured: OpenCodeConfiguredIntent, observedAt: string): AdapterMonitorObservationBatch {
    const updates: MonitorFamilyUpdate[] = [
      upsert('environment', 'root', { kind: 'environment', cwd: configured.cwd }),
    ];
    const model = configured.model ? modelCard(configured.model.providerID, configured.model.modelID) : undefined;
    if (model) {
      updates.push(upsert('model', 'configured:root', { kind: 'model', providerModelId: model, intent: 'configured' }));
    }
    if (configured.model?.variant) {
      updates.push(
        upsert('effort', 'configured:root', {
          kind: 'effort',
          value: configured.model.variant,
          intent: 'configured',
        }),
      );
    }
    if (configured.agent) {
      updates.push(
        upsert('mode', 'provider-session', {
          kind: 'mode',
          modeKind: 'provider-session',
          raw: configured.agent,
          normalized: configured.agent,
          intent: 'configured',
        }),
      );
    }
    return this.batch('configured', observedAt, updates, {
      phase: 'bootstrap',
      completeness: 'complete',
      evidence: [{ namespace: 'opencode:launch-intent', id: digest(configured) }],
    });
  }

  sessionBatch(
    info: OpenCodeSessionInfo | Record<string, unknown>,
    observedAt: string,
    phase: 'bootstrap' | 'resync' = 'bootstrap',
  ): AdapterMonitorObservationBatch | null {
    const sessionID = text(info.id);
    const root = this.root();
    if (!sessionID || !root) return null;
    const parentID = text(info.parentID);
    const child =
      sessionID !== root && parentID === root ? this.registerChild(sessionID, text(info.agent)) : this.actor(sessionID);
    if (sessionID !== root && !child) return null;
    const updates: MonitorFamilyUpdate[] = [];
    if (child) {
      updates.push(
        upsert('delegation', `actor:${child.runKey}`, {
          kind: 'actor',
          actor: child,
          state: 'unknown',
        }),
      );
    } else if (text(info.directory)) {
      updates.push(upsert('environment', 'root', { kind: 'environment', cwd: text(info.directory)! }));
    }
    const model = rec(info.model);
    const modelID = modelCard(model?.providerID, model?.id);
    if (modelID) {
      updates.push(
        upsert('model', `observed:${child?.runKey ?? 'root'}`, {
          kind: 'model',
          ...(child ? { actor: child } : {}),
          providerModelId: modelID,
          intent: 'observed',
        }),
      );
    }
    const variant = text(model?.variant);
    if (variant) {
      updates.push(
        upsert('effort', `observed:${child?.runKey ?? 'root'}`, {
          kind: 'effort',
          ...(child ? { actor: child } : {}),
          value: variant,
          intent: 'observed',
        }),
      );
    }
    if (!child && text(info.agent)) {
      updates.push(
        upsert('mode', 'provider-session', {
          kind: 'mode',
          modeKind: 'provider-session',
          raw: text(info.agent)!,
          normalized: text(info.agent)!,
          intent: 'observed',
        }),
      );
    }
    const time = rec(info.time);
    if (!child && finiteNonNegative(time?.compacting) !== undefined) {
      updates.push(upsert('compaction', 'root', { kind: 'compaction', active: true, trigger: 'session-state' }));
    }
    if (updates.length === 0) return null;
    return this.batch(`session-${sessionID}`, observedAt, updates, {
      phase,
      actor: child,
      completeness: 'complete',
      evidence: [
        {
          namespace: 'opencode:session-state',
          id: sessionID,
          revisionKey: digest(info),
          sourceObjectId: sessionID,
        },
      ],
    });
  }

  private observeModel(
    info: Record<string, unknown>,
    actor: ActorRunRef | undefined,
    updates: MonitorFamilyUpdate[],
  ): void {
    const nested = rec(info.model);
    const providerID = nested ? nested.providerID : info.providerID;
    const modelID = nested ? (nested.modelID ?? nested.id) : info.modelID;
    const model = modelCard(providerID, modelID);
    if (model) {
      updates.push(
        upsert('model', `observed:${actor?.runKey ?? 'root'}`, {
          kind: 'model',
          ...(actor ? { actor } : {}),
          providerModelId: model,
          intent: 'observed',
        }),
      );
    }
    const variant = text(nested?.variant ?? info.variant);
    if (variant) {
      updates.push(
        upsert('effort', `observed:${actor?.runKey ?? 'root'}`, {
          kind: 'effort',
          ...(actor ? { actor } : {}),
          value: variant,
          intent: 'observed',
        }),
      );
    }
  }

  private activeChild(actor: ActorRunRef, activity: string, updates: MonitorFamilyUpdate[]): void {
    updates.push(
      upsert('delegation', `actor:${actor.runKey}`, {
        kind: 'actor',
        actor,
        state: 'active',
        activity,
      }),
    );
  }

  private contextUpdate(tokens: unknown, actor: ActorRunRef | undefined): MonitorFamilyUpdate | undefined {
    if (actor) return undefined;
    const usage = tokenUsage(tokens);
    if (!usage) return undefined;
    const capacity = finiteNonNegative(this.options.contextWindowCapacityTokens);
    const capacityTokens = capacity !== undefined && capacity > 0 ? capacity : undefined;
    return upsert('context', 'root', {
      kind: 'context',
      usedTokens: usage.deltaTokens,
      ...(capacityTokens !== undefined ? { capacityTokens } : {}),
      percentageSource: capacityTokens !== undefined ? 'derived' : 'unavailable',
    });
  }

  recordBatch(
    record: OpenCodeSseRecord,
    observedAt: string,
    phase: 'bootstrap' | 'live' | 'resync' = 'live',
  ): AdapterMonitorObservationBatch | null {
    const root = this.root();
    if (!root) return null;
    const info = rec(record.properties.info);
    const part = rec(record.properties.part);
    const sessionID = recordSessionID(record);

    if (record.type === 'session.created' || record.type === 'session.updated') {
      const infoID = text(info?.id) ?? sessionID;
      if (infoID && infoID !== root && text(info?.parentID) === root) this.registerChild(infoID, text(info?.agent));
    }
    if (record.type === 'message.part.updated' && text(part?.type) === 'tool' && text(part?.tool) === 'task') {
      const state = rec(part?.state);
      const metadata = rec(state?.metadata);
      const childID = text(metadata?.sessionId);
      if (childID && (!text(metadata?.parentSessionId) || text(metadata?.parentSessionId) === root)) {
        this.registerChild(childID, text(rec(state?.input)?.subagent_type));
      }
    }

    if (!sessionID) return null;
    const actor = sessionID === root ? undefined : this.actor(sessionID);
    if (sessionID !== root && !actor) return null;
    const updates: MonitorFamilyUpdate[] = [];
    let quality: AdapterMonitorObservationBatch['quality'] = 'exact';
    let completeness: AdapterMonitorObservationBatch['completeness'] = 'partial';
    let provisional = false;

    switch (record.type) {
      case 'session.created':
      case 'session.updated': {
        if (actor) {
          this.activeChild(actor, 'Child session observed', updates);
          this.observeModel(info ?? {}, actor, updates);
        } else if (info) {
          const directory = text(info.directory);
          if (directory) updates.push(upsert('environment', 'root', { kind: 'environment', cwd: directory }));
          this.observeModel({ model: info.model }, undefined, updates);
          const agent = text(info.agent);
          if (agent) {
            updates.push(
              upsert('mode', 'provider-session', {
                kind: 'mode',
                modeKind: 'provider-session',
                raw: agent,
                normalized: agent,
                intent: 'observed',
              }),
            );
          }
        }
        break;
      }

      case 'message.updated': {
        if (!info) break;
        this.observeModel(info, actor, updates);
        const role = info.role;
        const messageID = text(info.id);
        const mode = text(info.mode) ?? (role === 'user' ? text(info.agent) : undefined);
        if (!actor && mode) {
          updates.push(
            upsert('mode', 'provider-session', {
              kind: 'mode',
              modeKind: 'provider-session',
              raw: mode,
              normalized: mode,
              intent: 'observed',
            }),
          );
        }
        if (actor) this.activeChild(actor, role === 'assistant' ? 'Responding' : 'Starting turn', updates);
        const time = rec(info.time);
        const completed = finiteNonNegative(time?.completed) !== undefined || text(info.finish) !== undefined;
        if (role === 'assistant' && messageID && completed) {
          const usage = usageUpdate(sessionID, messageID, info.tokens, actor);
          if (usage) updates.push(usage);
          const context = this.contextUpdate(info.tokens, actor);
          if (context) updates.push(context);
          if (!actor && mode === 'compaction') {
            updates.push(
              upsert('compaction', 'root', { kind: 'compaction', active: false, trigger: 'response-complete' }),
            );
          }
        } else if (role === 'assistant' && !completed && !actor) {
          updates.push(
            upsert('status', 'responding', {
              kind: 'activity',
              activityKind: mode === 'compaction' ? 'compacting' : 'responding',
              active: true,
              line: mode === 'compaction' ? 'Compacting' : 'Responding',
              since: effectiveAt(record) ?? observedAt,
            }),
          );
          if (mode === 'compaction') {
            updates.push(upsert('compaction', 'root', { kind: 'compaction', active: true, trigger: 'assistant-mode' }));
          }
        }
        break;
      }

      case 'message.part.updated': {
        const partType = text(part?.type);
        if (!partType) break;
        const messageID = text(part?.messageID);
        if (partType === 'step-finish' && messageID) {
          const usage = usageUpdate(sessionID, messageID, part?.tokens, actor);
          if (usage) updates.push(usage);
          const context = this.contextUpdate(part?.tokens, actor);
          if (context) updates.push(context);
        }
        if (partType === 'compaction' && !actor && phase === 'live') {
          const trigger = part?.overflow === true ? 'overflow' : part?.auto === true ? 'automatic' : 'manual';
          updates.push(upsert('compaction', 'root', { kind: 'compaction', active: true, trigger }));
        }
        const state = rec(part?.state);
        const status = text(state?.status);
        const activity =
          partType === 'reasoning'
            ? 'Reasoning'
            : partType === 'tool'
              ? `Using ${text(part?.tool) ?? 'tool'}`
              : partType === 'text'
                ? 'Responding'
                : undefined;
        if (actor && activity) this.activeChild(actor, activity, updates);
        if (!actor && partType === 'tool' && text(part?.callID) && status) {
          const key = `tool:${text(part?.callID)}`;
          if (status === 'completed' || status === 'error') updates.push(retract('status', key));
          else {
            updates.push(
              upsert('status', key, {
                kind: 'activity',
                activityKind: 'tool',
                active: true,
                line: `Using ${text(part?.tool) ?? 'tool'}`,
                since: effectiveAt(record) ?? observedAt,
              }),
            );
          }
        }
        break;
      }

      case 'session.status': {
        const status = text(rec(record.properties.status)?.type);
        if (!status) break;
        if (actor) {
          updates.push(
            upsert('delegation', `actor:${actor.runKey}`, {
              kind: 'actor',
              actor,
              state: status === 'idle' ? 'stopped' : 'active',
              ...(status === 'idle' ? {} : { activity: status === 'retry' ? 'Retrying' : 'Working' }),
            }),
          );
        } else if (status === 'idle') {
          updates.push(retract('status', 'session'), retract('status', 'responding'));
          updates.push(upsert('compaction', 'root', { kind: 'compaction', active: false, trigger: 'session-idle' }));
        } else {
          updates.push(
            upsert('status', 'session', {
              kind: 'activity',
              activityKind: 'other',
              active: true,
              line: status === 'retry' ? 'Retrying' : 'Working',
              since: effectiveAt(record) ?? observedAt,
            }),
          );
        }
        break;
      }

      case 'session.idle':
      case 'session.deleted': {
        if (actor) {
          updates.push(
            upsert('delegation', `actor:${actor.runKey}`, {
              kind: 'actor',
              actor,
              state: 'stopped',
            }),
          );
        } else if (record.type === 'session.idle') {
          updates.push(retract('status', 'session'), retract('status', 'responding'));
        }
        break;
      }

      case 'permission.asked': {
        const interactionId = text(record.properties.id);
        if (!interactionId) break;
        this.retainInteraction(interactionId, { ...(actor ? { actor } : {}), kind: 'permission' });
        updates.push(
          upsert('status', `permission:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: 'permission',
            state: 'pending',
            ...(actor ? { actor } : {}),
            permission: {
              requestId: interactionId,
              ...(text(record.properties.permission) ? { tool: text(record.properties.permission)! } : {}),
            },
          }),
        );
        break;
      }

      case 'permission.replied': {
        const interactionId = text(record.properties.requestID);
        if (!interactionId) break;
        const pending = this.interactions.get(interactionId);
        this.interactions.delete(interactionId);
        updates.push(
          upsert('status', `permission:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: 'permission',
            state: 'resolved',
            ...(pending?.actor ? { actor: pending.actor } : actor ? { actor } : {}),
          }),
        );
        break;
      }

      case 'question.asked': {
        const interactionId = text(record.properties.id);
        const questions = boundedQuestions(record.properties.questions);
        if (!interactionId || !questions) break;
        const kind = interactionKind(questions);
        this.retainInteraction(interactionId, { ...(actor ? { actor } : {}), kind });
        updates.push(
          upsert('status', `question:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: kind,
            state: 'pending',
            ...(actor ? { actor } : {}),
            questions,
          }),
        );
        break;
      }

      case 'question.replied':
      case 'question.rejected': {
        const interactionId = text(record.properties.requestID);
        if (!interactionId) break;
        const pending = this.interactions.get(interactionId);
        this.interactions.delete(interactionId);
        updates.push(
          upsert('status', `question:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: pending?.kind && pending.kind !== 'permission' ? pending.kind : ('mixed' as const),
            state: record.type === 'question.replied' ? 'resolved' : 'cancelled',
            ...(pending?.actor ? { actor: pending.actor } : actor ? { actor } : {}),
          }),
        );
        break;
      }

      case 'session.compacted':
        if (!actor) {
          updates.push(retract('context', 'root'));
          updates.push(upsert('compaction', 'root', { kind: 'compaction', active: false, trigger: 'completed' }));
        }
        break;
    }

    if (updates.length === 0) return null;
    return this.batch(record.type.replaceAll('.', '-'), observedAt, updates, {
      phase,
      effectiveAt: effectiveAt(record),
      quality,
      completeness,
      provisional,
      actor,
      evidence: this.evidence(record),
    });
  }

  /** Complete child list corrects starts/stops missed while SSE was disconnected. */
  childrenSnapshotBatch(
    children: readonly OpenCodeSessionInfo[],
    statuses: Readonly<Record<string, Record<string, unknown>>>,
    observedAt: string,
    phase: 'bootstrap' | 'resync',
  ): AdapterMonitorObservationBatch {
    const values: Array<{ key: string; value: MonitorFamilyValueMap['delegation'] }> = [];
    const root = this.root();
    for (const child of children) {
      if (!root || child.parentID !== root) continue;
      const actor = this.registerChild(child.id, child.agent);
      if (!actor) continue;
      const status = text(statuses[child.id]?.type);
      values.push({
        key: `actor:${actor.runKey}`,
        value: {
          kind: 'actor',
          actor,
          state: status && status !== 'idle' ? 'active' : 'stopped',
          ...(status && status !== 'idle' ? { activity: status === 'retry' ? 'Retrying' : 'Working' } : {}),
        },
      });
    }
    return this.batch('children-snapshot', observedAt, [replace('delegation', values)], {
      phase,
      completeness: 'complete',
      evidence: [
        {
          namespace: 'opencode:durable-http',
          id: `children-snapshot:${root ?? 'pending'}`,
          revisionKey: digest(children),
        },
      ],
    });
  }

  railUnavailableBatch(
    observedAt: string,
    reason = 'OpenCode SSE observation unavailable',
  ): AdapterMonitorObservationBatch {
    const capabilities = OPENCODE_MONITOR_CAPABILITIES.map((capability) =>
      capability.support === 'unsupported'
        ? capability
        : {
            ...capability,
            support: 'degraded' as const,
            limitations: [...capability.limitations, `${reason}; attached TUI host liveness is unchanged.`],
          },
    );
    const coverage: ObservationCoverage[] = OPENCODE_MONITOR_CAPABILITIES.filter(
      ({ support }) => support !== 'unsupported',
    ).map(({ family }) => ({
      family,
      completeness: 'unavailable',
      asOf: observedAt,
      reason,
    }));
    return this.batch('rail-unavailable', observedAt, [], {
      quality: 'unknown',
      completeness: 'unavailable',
      readiness: 'degraded',
      capabilities,
      coverage,
      evidence: [{ namespace: 'opencode:sse-rail', id: `unavailable:${this.sequence + 1}` }],
    });
  }

  railRecoveringBatch(observedAt: string): AdapterMonitorObservationBatch {
    return this.batch('rail-recovering', observedAt, [], {
      phase: 'resync',
      quality: 'unknown',
      completeness: 'unavailable',
      readiness: 'loading',
      evidence: [{ namespace: 'opencode:sse-rail', id: `recovering:${this.sequence + 1}` }],
    });
  }

  railReadyBatch(observedAt: string): AdapterMonitorObservationBatch {
    const coverage: ObservationCoverage[] = OPENCODE_MONITOR_CAPABILITIES.filter(
      ({ support }) => support !== 'unsupported',
    ).map(({ family, support }) => ({
      family,
      completeness: support === 'supported' ? 'complete' : 'partial',
      asOf: observedAt,
      ...(support === 'degraded' ? { reason: 'Provider-native limitation remains after durable resync' } : {}),
    }));
    return this.batch('rail-ready', observedAt, [], {
      phase: 'resync',
      completeness: 'complete',
      readiness: 'ready',
      capabilities: [...OPENCODE_MONITOR_CAPABILITIES],
      coverage,
      evidence: [{ namespace: 'opencode:sse-rail', id: `ready:${this.sequence + 1}` }],
    });
  }
}
