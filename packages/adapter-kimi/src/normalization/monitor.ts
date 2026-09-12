/** Kimi wire 1.5 facts projected onto the evidence-backed monitor SPI. */

import { randomUUID } from 'node:crypto';
import type { ActorRunRef, MonitorMetricFamily, MonitorStructuredQuestion } from '@vibecook/puppeteer-core';
import type {
  AdapterMonitorObservationBatch,
  EvidenceRef,
  MonitorFamilyUpdate,
  MonitorFamilyValueMap,
  ObservationCapability,
  ObservationCoverage,
} from '@vibecook/puppeteer-core/monitor-spi';
import type { KimiObservedEvent, KimiObservedRecord } from '../observation/session-observer.js';
import { KIMI_CONTRACT, KIMI_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

export { KIMI_MONITOR_CAPABILITIES } from './monitor-capabilities.js';

const MAX_PENDING_QUESTIONS = 256;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_PROMPT_LENGTH = 1_024;
const MAX_HEADER_LENGTH = 128;
const MAX_OPTION_LENGTH = 256;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function boundedText(value: unknown, length: number): string | undefined {
  return text(value)?.slice(0, length);
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

function questions(value: unknown): MonitorStructuredQuestion[] | undefined {
  const request = rec(value);
  if (!Array.isArray(request?.questions)) return undefined;
  const result: MonitorStructuredQuestion[] = [];
  for (const candidate of request.questions.slice(0, MAX_QUESTIONS)) {
    const question = rec(candidate);
    const prompt = boundedText(question?.question ?? question?.prompt, MAX_PROMPT_LENGTH);
    if (!question || !prompt) continue;
    const options = Array.isArray(question.options)
      ? question.options.slice(0, MAX_OPTIONS).flatMap((candidateOption) => {
          const option = rec(candidateOption);
          const label = boundedText(option?.label, MAX_OPTION_LENGTH);
          if (!option || !label) return [];
          const description = boundedText(option.description, MAX_OPTION_LENGTH);
          return [{ label, ...(description ? { description } : {}) }];
        })
      : [];
    const id = boundedText(question.id, MAX_HEADER_LENGTH);
    const header = boundedText(question.header, MAX_HEADER_LENGTH);
    result.push({
      ...(id ? { id } : {}),
      ...(header ? { header } : {}),
      prompt,
      ...(options.length > 0 ? { options } : {}),
      allowMultiple: question.multiSelect === true || question.multi_select === true,
      // Kimi's pinned chooser always supplies a synthetic Other option.
      allowFreeForm: true,
    });
  }
  return result.length > 0 ? result : undefined;
}

export interface KimiConfiguredIntent {
  cwd?: string;
  model?: string;
  permissionMode?: string;
  plan?: boolean;
}

export interface KimiMonitorEvidenceOptions {
  nativeSessionId: () => string;
  epoch?: string;
}

interface PendingQuestion {
  actor?: ActorRunRef;
}

/** Stateful projector; original provider records remain attached as candidate evidence. */
export class KimiMonitorEvidence {
  private readonly epoch: string;
  private sequence = 0;
  private readonly agentTypes = new Map<string, string | undefined>();
  private readonly parentAgents = new Map<string, string>();
  private readonly seenAgents = new Set<string>();
  private readonly stoppedAgents = new Set<string>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private compactionTrigger: string | undefined;

  constructor(private readonly options: KimiMonitorEvidenceOptions) {
    this.epoch = options.epoch ?? `kimi:${randomUUID()}`;
  }

  private actor(agentId: string): ActorRunRef | undefined {
    if (agentId === 'main') return undefined;
    const root = this.options.nativeSessionId();
    const parent = this.parentAgents.get(agentId);
    return {
      rootSessionKey: root,
      runKey: `${root}:actor:${agentId}`,
      role: 'child',
      parentRunKey: parent && parent !== 'main' ? `${root}:actor:${parent}` : `${root}:root`,
      nativeSessionId: root,
      nativeAgentId: agentId,
      ...(this.agentTypes.get(agentId) ? { nativeAgentType: this.agentTypes.get(agentId) } : {}),
    };
  }

  private metricKey(actor: ActorRunRef | undefined): string {
    return actor ? `actor:${actor.runKey}` : 'root';
  }

  private evidence(observed: KimiObservedRecord): EvidenceRef[] {
    return [
      {
        namespace: 'kimi:wire-record',
        id: `${this.options.nativeSessionId()}:${observed.agentId}:${observed.cursorEnd}`,
        sourceObjectId: observed.agentId,
        cursorStart: observed.cursorStart,
        cursorEnd: observed.cursorEnd,
      },
    ];
  }

  private batch(
    label: string,
    observedAt: string,
    updates: MonitorFamilyUpdate[],
    options: {
      phase?: AdapterMonitorObservationBatch['phase'];
      effectiveAt?: string;
      quality?: AdapterMonitorObservationBatch['quality'];
      completeness?: AdapterMonitorObservationBatch['completeness'];
      provisional?: boolean;
      readiness?: AdapterMonitorObservationBatch['readiness'];
      agentId?: string;
      evidence?: EvidenceRef[];
      capabilities?: ObservationCapability[];
      coverage?: ObservationCoverage[];
      cursorEnd?: number;
    } = {},
  ): AdapterMonitorObservationBatch {
    this.sequence += 1;
    const actor = options.agentId ? this.actor(options.agentId) : undefined;
    return {
      schemaVersion: 1,
      batchId: `${label}:${this.sequence}`,
      producer: {
        id: 'kimi:wire-monitor',
        epoch: this.epoch,
        sequence: this.sequence,
        contractVersion: KIMI_CONTRACT,
      },
      phase: options.phase ?? 'live',
      observedAt,
      ...(options.effectiveAt ? { effectiveAt: options.effectiveAt } : {}),
      quality: options.quality ?? 'exact',
      completeness: options.completeness ?? 'complete',
      provisional: options.provisional ?? false,
      readiness: options.readiness ?? 'ready',
      scope: {
        nativeSessionId: this.options.nativeSessionId(),
        ...(actor ? { actorRunKey: actor.runKey } : {}),
      },
      updates,
      sourceWatermarks:
        options.agentId && options.cursorEnd !== undefined
          ? [
              {
                sourceId: `kimi:wire:${options.agentId}`,
                sourceEpoch: `${this.options.nativeSessionId()}:${options.agentId}`,
                cursor: String(options.cursorEnd),
                observedThrough: options.effectiveAt ?? observedAt,
              },
            ]
          : [],
      evidence: options.evidence ?? [],
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.coverage ? { coverage: options.coverage } : {}),
    };
  }

  capabilitiesBatch(observedAt: string): AdapterMonitorObservationBatch {
    return this.batch('capabilities', observedAt, [], {
      phase: 'bootstrap',
      capabilities: [...KIMI_MONITOR_CAPABILITIES],
    });
  }

  configuredBatch(configured: KimiConfiguredIntent, observedAt: string): AdapterMonitorObservationBatch | null {
    const updates: MonitorFamilyUpdate[] = [];
    if (configured.cwd) updates.push(upsert('environment', 'root', { kind: 'environment', cwd: configured.cwd }));
    if (configured.model) {
      updates.push(
        upsert('model', 'configured:root', {
          kind: 'model',
          providerModelId: configured.model,
          intent: 'configured',
        }),
      );
    }
    if (configured.permissionMode) {
      updates.push(
        upsert('mode', 'provider-permission', {
          kind: 'mode',
          modeKind: 'provider-permission',
          raw: configured.permissionMode,
          normalized: configured.permissionMode,
          intent: 'configured',
        }),
      );
    }
    if (configured.plan) {
      updates.push(
        upsert('mode', 'provider-session', {
          kind: 'mode',
          modeKind: 'provider-session',
          raw: 'plan',
          normalized: 'plan',
          intent: 'configured',
        }),
      );
    }
    if (updates.length === 0) return null;
    return this.batch('configured', observedAt, updates, {
      phase: 'bootstrap',
      evidence: [{ namespace: 'kimi:launch-intent', id: this.options.nativeSessionId() }],
    });
  }

  recordBatch(observed: KimiObservedRecord, observedAt: string): AdapterMonitorObservationBatch | null {
    const body = rec(observed.record);
    const type = text(body?.type);
    if (!body || !type) return null;
    const actor = this.actor(observed.agentId);
    const metricKey = this.metricKey(actor);
    const updates: MonitorFamilyUpdate[] = [];
    let quality: AdapterMonitorObservationBatch['quality'] = 'exact';
    let completeness: AdapterMonitorObservationBatch['completeness'] = 'complete';
    let provisional = false;

    const markSourceOnly = (): void => {
      quality = 'unknown';
      completeness = 'partial';
      provisional = true;
    };

    const childState = (state: 'active' | 'idle' | 'stopped', activity?: string): void => {
      const child = this.actor(observed.agentId);
      if (!child) return;
      this.seenAgents.add(observed.agentId);
      const effectiveState = this.stoppedAgents.has(observed.agentId) ? 'stopped' : state;
      updates.push(
        upsert('delegation', `actor:${child.runKey}`, {
          kind: 'actor',
          actor: child,
          state: effectiveState,
          ...(effectiveState !== 'stopped' && activity ? { activity } : {}),
        }),
      );
    };

    if (observed.agentId !== 'main' && !this.seenAgents.has(observed.agentId)) {
      childState('active', 'Subagent active');
    }

    switch (type) {
      case 'profile.bind': {
        const profileName = text(body.profileName);
        if (observed.agentId !== 'main' && profileName) this.agentTypes.set(observed.agentId, profileName);
        if (observed.agentId !== 'main') childState('active', 'Subagent active');
        const currentActor = this.actor(observed.agentId);
        const currentKey = this.metricKey(currentActor);
        const disclosure = rec(body.environmentDisclosure);
        const cwd = text(disclosure?.cwd);
        if (!currentActor && cwd) updates.push(upsert('environment', 'root', { kind: 'environment', cwd }));
        const model = text(body.modelAlias);
        if (model) {
          updates.push(
            upsert('model', `configured:${currentKey}`, {
              kind: 'model',
              ...(currentActor ? { actor: currentActor } : {}),
              providerModelId: model,
              intent: 'configured',
            }),
          );
        }
        const effort = text(body.thinkingEffort);
        if (effort) {
          updates.push(
            upsert('effort', `configured:${currentKey}`, {
              kind: 'effort',
              ...(currentActor ? { actor: currentActor } : {}),
              value: effort,
              intent: 'configured',
            }),
          );
        }
        break;
      }

      case 'permission.set_mode': {
        if (observed.agentId !== 'main') break;
        const mode = text(body.mode);
        if (mode) {
          if (!['manual', 'yolo', 'auto'].includes(mode)) markSourceOnly();
          updates.push(
            upsert('mode', 'provider-permission', {
              kind: 'mode',
              modeKind: 'provider-permission',
              raw: mode,
              normalized: mode,
              intent: 'observed',
            }),
          );
        }
        break;
      }

      case 'llm.request': {
        if (actor) childState('active', 'Waiting for model');
        const currentActor = this.actor(observed.agentId);
        const currentKey = this.metricKey(currentActor);
        const model = text(body.model);
        if (model) {
          updates.push(
            upsert('model', `observed:${currentKey}`, {
              kind: 'model',
              ...(currentActor ? { actor: currentActor } : {}),
              providerModelId: model,
              intent: 'observed',
            }),
          );
        }
        const effort = text(body.thinkingEffort);
        if (effort) {
          updates.push(
            upsert('effort', `observed:${currentKey}`, {
              kind: 'effort',
              ...(currentActor ? { actor: currentActor } : {}),
              value: effort,
              intent: 'observed',
            }),
          );
        }
        break;
      }

      case 'usage.record': {
        const usage = rec(body.usage);
        const inputTokens = finiteNonNegative(usage?.inputOther);
        const outputTokens = finiteNonNegative(usage?.output);
        const cacheReadTokens = finiteNonNegative(usage?.inputCacheRead);
        const cacheCreationTokens = finiteNonNegative(usage?.inputCacheCreation);
        if (
          inputTokens !== undefined &&
          outputTokens !== undefined &&
          cacheReadTokens !== undefined &&
          cacheCreationTokens !== undefined
        ) {
          const usageId = `kimi-response:${this.options.nativeSessionId()}:${observed.agentId}:${observed.cursorEnd}`;
          updates.push(
            upsert('usage', usageId, {
              kind: 'usage',
              usageId,
              ...(actor ? { actor } : {}),
              boundary: 'response',
              canonical: true,
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheCreationTokens,
            }),
          );
          updates.push(
            upsert('context', metricKey, {
              kind: 'context',
              ...(actor ? { actor } : {}),
              usedTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
              percentageSource: 'unavailable',
            }),
          );
        }
        if (actor) childState('active', 'Responding');
        break;
      }

      case 'turn.prompt':
        if (actor) childState('active', 'Starting turn');
        break;

      case 'context.append_loop_event': {
        if (!actor) break;
        const loop = rec(body.event);
        const loopType = text(loop?.type);
        const partType = text(rec(loop?.part)?.type);
        if (loopType === 'content.part' && partType === 'think') childState('active', 'Reasoning');
        else if (loopType === 'tool.call') childState('active', 'Using tool');
        else childState('active', 'Responding');
        break;
      }

      case 'turn.ended':
        if (actor) childState('idle');
        break;

      case 'task.started':
      case 'task.terminated': {
        const info = rec(body.info);
        const taskKind = text(info?.kind);
        const terminal = type === 'task.terminated';
        if (taskKind === 'agent') {
          markSourceOnly();
          const childId = text(info?.agentId);
          if (childId) {
            this.parentAgents.set(childId, observed.agentId);
            if (terminal) this.stoppedAgents.add(childId);
            else this.stoppedAgents.delete(childId);
            const childType = text(info?.subagentType);
            if (childType) this.agentTypes.set(childId, childType);
            const child = this.actor(childId)!;
            updates.push(
              upsert('delegation', `actor:${child.runKey}`, {
                kind: 'actor',
                actor: child,
                state: terminal ? 'stopped' : 'active',
                ...(!terminal ? { activity: 'Subagent active' } : {}),
              }),
            );
            const model = text(info?.model);
            if (model && !terminal) {
              updates.push(
                upsert('model', `configured:actor:${child.runKey}`, {
                  kind: 'model',
                  actor: child,
                  providerModelId: model,
                  intent: 'configured',
                }),
              );
            }
            const effort = text(info?.thinkingEffort);
            if (effort && !terminal) {
              updates.push(
                upsert('effort', `configured:actor:${child.runKey}`, {
                  kind: 'effort',
                  actor: child,
                  value: effort,
                  intent: 'configured',
                }),
              );
            }
          }
        }
        break;
      }

      case 'interaction.request': {
        if (body.kind !== 'question') break;
        markSourceOnly();
        const interactionId = text(body.id);
        if (!interactionId) break;
        const pendingKey = `${observed.agentId}:${interactionId}`;
        const parsedQuestions = questions(body.request);
        const interactionKind = parsedQuestions?.some((question) => (question.options?.length ?? 0) > 0)
          ? 'mixed'
          : 'free-form';
        if (!this.pendingQuestions.has(pendingKey) && this.pendingQuestions.size >= MAX_PENDING_QUESTIONS) {
          const oldest = this.pendingQuestions.keys().next().value as string | undefined;
          if (oldest) this.pendingQuestions.delete(oldest);
        }
        this.pendingQuestions.set(pendingKey, { ...(actor ? { actor } : {}) });
        updates.push(
          upsert('status', `question:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind,
            state: 'pending',
            ...(actor ? { actor } : {}),
            ...(parsedQuestions ? { questions: parsedQuestions } : {}),
            detail: 'Kimi needs input',
          }),
        );
        break;
      }

      case 'interaction.resolved': {
        const interactionId = text(body.id);
        const pendingKey = interactionId ? `${observed.agentId}:${interactionId}` : undefined;
        const pending = pendingKey ? this.pendingQuestions.get(pendingKey) : undefined;
        if (!interactionId || !pending) break;
        markSourceOnly();
        this.pendingQuestions.delete(pendingKey!);
        updates.push(
          upsert('status', `question:${interactionId}`, {
            kind: 'interaction',
            interactionId,
            interactionKind: 'mixed',
            state: 'resolved',
            ...(pending.actor ? { actor: pending.actor } : {}),
          }),
        );
        break;
      }

      case 'plan_mode.enter':
        if (observed.agentId !== 'main') break;
        markSourceOnly();
        updates.push(
          upsert('mode', 'provider-session', {
            kind: 'mode',
            modeKind: 'provider-session',
            raw: 'plan',
            normalized: 'plan',
            intent: 'observed',
          }),
        );
        break;

      case 'plan_mode.exit':
      case 'plan_mode.cancel':
        if (observed.agentId !== 'main') break;
        markSourceOnly();
        updates.push(retract('mode', 'provider-session'));
        break;

      case 'full_compaction.begin':
        markSourceOnly();
        if (observed.agentId === 'main') {
          this.compactionTrigger = text(body.source);
          updates.push(
            upsert('compaction', 'root', {
              kind: 'compaction',
              active: true,
              ...(this.compactionTrigger ? { trigger: this.compactionTrigger } : {}),
            }),
          );
        }
        break;

      case 'full_compaction.complete':
      case 'full_compaction.cancel':
        markSourceOnly();
        updates.push(retract('context', metricKey));
        if (observed.agentId === 'main') {
          updates.push(
            upsert('compaction', 'root', {
              kind: 'compaction',
              active: false,
              trigger: type === 'full_compaction.cancel' ? 'cancelled' : (this.compactionTrigger ?? 'completed'),
              outcome: type === 'full_compaction.cancel' ? 'cancelled' : 'completed',
            }),
          );
          this.compactionTrigger = undefined;
        }
        break;

      case 'context.clear':
      case 'context.undo':
      case 'context.apply_compaction':
        markSourceOnly();
        updates.push(retract('context', metricKey));
        break;

      // Swarm/goal/cron-like records deliberately remain raw. None proves a
      // stable team or workflow identity, membership, run, or readable file.
      default:
        break;
    }

    if (updates.length === 0) return null;
    return this.batch(type.replaceAll('.', '-'), observedAt, updates, {
      phase: observed.replay ? 'bootstrap' : 'live',
      effectiveAt: observed.timestamp,
      quality,
      completeness,
      provisional,
      agentId: observed.agentId,
      evidence: this.evidence(observed),
      cursorEnd: observed.cursorEnd,
    });
  }

  /** Compatibility observer diagnostics that change evidence coverage, not host lifecycle. */
  observerEventBatch(observed: KimiObservedEvent, observedAt: string): AdapterMonitorObservationBatch | null {
    if (
      observed.event.type !== 'adapter:native-event' ||
      observed.event.adapter !== 'kimi' ||
      observed.event.nativeType !== 'replay-window-truncated'
    ) {
      return null;
    }
    const native = rec(observed.nativeEvent);
    const agentId = text(native?.agentId) ?? 'main';
    const actor = this.actor(agentId);
    const coverage: ObservationCoverage[] = KIMI_MONITOR_CAPABILITIES.filter(
      ({ support }) => support !== 'unsupported',
    ).map(({ family, actorScope }) => ({
      family,
      completeness: 'partial',
      asOf: observedAt,
      ...(actor && actorScope === 'current-actors' ? { actor } : {}),
      reason: 'Older Kimi journal bytes are outside the bounded replay window',
    }));
    return this.batch('replay-window-truncated', observedAt, [], {
      phase: 'bootstrap',
      quality: 'exact',
      completeness: 'partial',
      agentId,
      evidence: [
        {
          namespace: 'kimi:wire-observer',
          id: `replay-window-truncated:${this.options.nativeSessionId()}:${agentId}`,
        },
      ],
      coverage,
    });
  }

  /** Journal corruption/loss degrades evidence readiness without claiming the TUI process died. */
  observerDegradedBatch(observedAt: string): AdapterMonitorObservationBatch {
    const capabilities = KIMI_MONITOR_CAPABILITIES.map((capability) =>
      capability.support === 'unsupported'
        ? capability
        : {
            ...capability,
            support: 'degraded' as const,
            limitations: [
              ...capability.limitations,
              'Kimi wire observation is unavailable or incomplete; native host liveness is unchanged.',
            ],
          },
    );
    const coverage: ObservationCoverage[] = KIMI_MONITOR_CAPABILITIES.filter(
      ({ support }) => support !== 'unsupported',
    ).map(({ family }) => ({
      family,
      completeness: 'unavailable',
      asOf: observedAt,
      reason: 'Kimi durable-wire observation unavailable or incomplete',
    }));
    return this.batch('observer-degraded', observedAt, [], {
      quality: 'unknown',
      completeness: 'unavailable',
      readiness: 'degraded',
      evidence: [{ namespace: 'kimi:wire-observer', id: `degraded:${this.sequence + 1}` }],
      capabilities,
      coverage,
    });
  }
}
