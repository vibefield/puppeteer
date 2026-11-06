import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { agentEventCategory, agentEventType, type AgentEvent, type AgentEventEnvelope } from '../events/index.js';
import type {
  ActorRunRef,
  AgentMonitorState,
  EvidenceCompleteness,
  MonitorActivityKind,
  MonitorMetricFamily,
  MonitorNotification,
  MonitorStructuredQuestion,
} from './types.js';
import type {
  MonitorAccumulatorInput,
  MonitorAccumulatorState,
  MonitorEnvironmentFamilyValue,
  MonitorFamilyReplacement,
  MonitorFamilyUpdate,
  MonitorFamilyUpsert,
  MonitorFamilyValueMap,
  MonitorInteractionState,
  MonitorObservationPhase,
  MonitorRunLifecycle,
  MonitorRunStatusObservation,
  MonitorUsageFamilyValue,
  ObservationCapability,
  ObservationCoverage,
  RuntimeMonitorInput,
} from './internal-types.js';
import * as projection from './project.js';
import { projectAgentMonitorState } from './project.js';
import { createMonitorAccumulatorState, reduceMonitorAccumulator, translateAgentEventEnvelope } from './reduce.js';

// The oracle for the monitor's projection cost (RV #9). Seeded input sequences, and every public output they
// produce: at each step the bounded projection (`previous` chained, `asOf` stepping across the burn window and the
// cost buckets), the unbounded projection over a wide window (chained the same way), and the step's notifications.
// They were recorded at the commit before any refactor, so a change to how often or over what the monitor
// projects must reproduce them byte for byte.
//
// Record only at that commit, never to bless a later output (in packages/core):
//   PUPPETEER_MONITOR_EQUIVALENCE_WRITE=1 ../../node_modules/.bin/vitest run src/monitor/projection-cost.test.ts
// It writes projection-equivalence.golden.json beside this file. Without the flag the test compares, and fails
// when the golden is missing. Keys and ids are lowercase ASCII, '-' and zero-padded digits, so the default
// collation of any host sorts them alike.

const GOLDEN_PATH = fileURLToPath(new URL('./projection-equivalence.golden.json', import.meta.url));
const WRITE_FLAG = 'PUPPETEER_MONITOR_EQUIVALENCE_WRITE';
const RUN = 'run-1';
const T0 = Date.parse('2026-08-16T12:00:00.000Z');
const WIDE_WINDOW_MS = 900_000;
/** Each projection's boundary after its input: on it, across the 60 s window and 30 s buckets, past the history. */
const AS_OF_OFFSETS_MS = [0, 1_000, 29_999, 30_000, 59_999, 60_000, 60_001, 119_000, 601_000, 900_001] as const;

const ROOT: ActorRunRef = { rootSessionKey: 'native-1', runKey: 'native-1:root', role: 'root' };
const LANE: ActorRunRef = { rootSessionKey: 'native-1', runKey: 'native-1:actor-derived:lane', role: 'auxiliary' };
/** A child the source never joined to a native agent id: attribution, not a proven subagent. */
const UNJOINED: ActorRunRef = { rootSessionKey: 'native-1', runKey: 'native-1:actor:unjoined', role: 'child' };

function child(id: string): ActorRunRef {
  return {
    rootSessionKey: 'native-1',
    runKey: `native-1:actor:${id}`,
    role: 'child',
    parentRunKey: 'native-1:root',
    nativeAgentId: id,
  };
}

const USAGE_ACTORS = [undefined, undefined, ROOT, child('alpha'), child('beta'), LANE, UNJOINED] as const;

const CAPABILITIES: ObservationCapability[] = [
  {
    family: 'usage',
    support: 'supported',
    actorScope: 'session',
    latency: 'response',
    source: 'semantic-c',
    limitations: [],
  },
  {
    family: 'status',
    support: 'degraded',
    actorScope: 'root',
    latency: 'hook',
    source: 'semantic-c',
    limitations: ['no tool rail'],
  },
  {
    family: 'context',
    support: 'unsupported',
    actorScope: 'root',
    latency: 'sample',
    source: 'semantic-c',
    limitations: [],
  },
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function upsert<F extends MonitorMetricFamily>(
  family: F,
  key: string,
  value: MonitorFamilyValueMap[F],
): MonitorFamilyUpsert<F> {
  return { family, operation: 'upsert', key, value };
}

function retract(family: MonitorMetricFamily, key: string): MonitorFamilyUpdate {
  return { family, operation: 'retract', key } as MonitorFamilyUpdate;
}

function replace<F extends MonitorMetricFamily>(
  family: F,
  values: Array<{ key: string; value: MonitorFamilyValueMap[F] }>,
  coverage: EvidenceCompleteness,
): MonitorFamilyReplacement<F> {
  return { family, operation: 'replace', values, coverage };
}

type UsageFields = Omit<MonitorUsageFamilyValue, 'kind' | 'usageId'>;

function usage(usageId: string, fields: UsageFields, key = usageId): MonitorFamilyUpsert<'usage'> {
  return upsert('usage', key, { kind: 'usage', usageId, ...fields });
}

function sample(cumulativeTokens: number, actor?: ActorRunRef, canonical = false): UsageFields {
  return {
    origin: 'telemetry',
    boundary: 'sample',
    canonical,
    cumulativeTokens,
    ...(actor ? { actor } : {}),
  };
}

function run(lifecycle: MonitorRunLifecycle, alive: boolean, extra: Partial<MonitorRunStatusObservation> = {}) {
  return upsert('status', 'run', { kind: 'run', lifecycle, alive, ...extra });
}

function activity(
  key: string,
  activityKind: MonitorActivityKind,
  active: boolean,
  options: { actor?: ActorRunRef; leaseId?: string; line?: string; since?: string } = {},
) {
  return upsert('status', key, { kind: 'activity', activityKind, active, ...options });
}

function permission(id: string, state: MonitorInteractionState, actor?: ActorRunRef) {
  return upsert('status', actor ? `${id}-${actor.nativeAgentId}` : id, {
    kind: 'interaction',
    interactionId: id,
    interactionKind: 'permission',
    state,
    permission: { requestId: id, tool: 'bash' },
    ...(actor ? { actor } : {}),
  });
}

function question(id: string, state: MonitorInteractionState, questions: MonitorStructuredQuestion[]) {
  return upsert('status', id, { kind: 'interaction', interactionId: id, interactionKind: 'mixed', state, questions });
}

function options(count: number): Array<{ label: string }> {
  return Array.from({ length: count }, (_, index) => ({ label: `option-${index.toString().padStart(3, '0')}` }));
}

interface Step {
  input: MonitorAccumulatorInput;
  asOf: string;
}

interface RuntimeOptions {
  phase?: RuntimeMonitorInput['phase'];
  identity?: RuntimeMonitorInput['identity'];
  effectiveAt?: string;
  provisional?: boolean;
  completeness?: EvidenceCompleteness;
}

interface SemanticOptions {
  producer?: string;
  epoch?: string;
  phase?: MonitorObservationPhase;
  sequence?: number;
  readiness?: 'loading' | 'ready' | 'degraded';
  completeness?: EvidenceCompleteness;
  effectiveAt?: string;
  provisional?: boolean;
  capabilities?: ObservationCapability[];
  coverage?: ObservationCoverage[];
}

/** One seeded input sequence, and what its moves remember of the evidence they produced. */
class Scenario {
  readonly steps: Step[] = [];
  readonly runtimeUsage: string[] = [];
  readonly semanticUsage: string[] = [];
  readonly epochUsage: string[] = [];
  readonly pending: string[] = [];
  readonly leases: string[] = [];
  readonly records: string[] = [];
  readonly counters = new Map<string, number>();
  epoch = 1;
  sequence = 0;
  last: MonitorAccumulatorInput | undefined;
  private readonly random: () => number;
  private ms = T0;
  private serial = 0;

  constructor(
    readonly name: string,
    seed: number,
  ) {
    this.random = mulberry32(seed);
  }

  chance(probability: number): boolean {
    return this.random() < probability;
  }

  int(below: number): number {
    return Math.floor(this.random() * below);
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)]!;
  }

  take(values: string[]): string | undefined {
    return values.length > 0 ? values.splice(this.int(values.length), 1)[0] : undefined;
  }

  id(prefix: string): string {
    return `${prefix}-${(++this.serial).toString().padStart(4, '0')}`;
  }

  at(offsetMs = 0): string {
    return new Date(this.ms + offsetMs).toISOString();
  }

  /** Moves the clock 1–20 s; every input a move makes is stamped with the clock as it stands. */
  tick(): void {
    this.ms += 1_000 * (1 + this.int(20));
  }

  /** The next cumulative counter of one sample stream. */
  count(stream: string): number {
    const next = (this.counters.get(stream) ?? 0) + this.int(5_000);
    this.counters.set(stream, next);
    return next;
  }

  runtime(updates: MonitorFamilyUpdate[], options: RuntimeOptions = {}): void {
    const eventId = this.id('event');
    this.push({
      kind: 'runtime',
      schemaVersion: 1,
      eventId,
      ...(options.identity ? { identity: options.identity } : {}),
      runtimeRunId: RUN,
      runtimeEpoch: 1,
      phase: options.phase ?? 'live',
      observedAt: this.at(),
      ...(options.effectiveAt ? { effectiveAt: options.effectiveAt } : {}),
      source: { id: 'native-hook', kind: 'agent-event' },
      quality: 'exact',
      completeness: options.completeness ?? 'complete',
      provisional: options.provisional ?? false,
      updates,
      evidence: [{ namespace: 'agent-event', id: eventId }],
    });
  }

  semantic(updates: MonitorFamilyUpdate[], options: SemanticOptions = {}): void {
    this.push({
      kind: 'semantic',
      schemaVersion: 1,
      batchId: this.id('batch'),
      producer: {
        id: options.producer ?? 'semantic-a',
        epoch: options.epoch ?? 'epoch-1',
        ...(options.sequence !== undefined ? { sequence: options.sequence } : {}),
      },
      phase: options.phase ?? 'live',
      observedAt: this.at(),
      ...(options.effectiveAt ? { effectiveAt: options.effectiveAt } : {}),
      quality: 'exact',
      completeness: options.completeness ?? 'complete',
      provisional: options.provisional ?? false,
      ...(options.readiness ? { readiness: options.readiness } : {}),
      runtimeRunId: RUN,
      runtimeEpoch: 1,
      updates,
      sourceWatermarks: [],
      evidence: [],
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.coverage ? { coverage: options.coverage } : {}),
    });
  }

  workspace(recordId: string, value: MonitorEnvironmentFamilyValue): void {
    this.push({
      kind: 'workspace',
      schemaVersion: 1,
      recordId,
      runtimeRunId: RUN,
      runtimeEpoch: 1,
      observedAt: this.at(),
      source: { id: 'workspace', kind: 'workspace-observation' },
      quality: 'exact',
      completeness: 'complete',
      provisional: false,
      evidence: [],
      operation: 'upsert',
      value,
    });
  }

  workspaceRetract(targetRecordId: string): void {
    this.push({
      kind: 'workspace',
      schemaVersion: 1,
      recordId: this.id('record'),
      runtimeRunId: RUN,
      runtimeEpoch: 1,
      observedAt: this.at(),
      source: { id: 'workspace', kind: 'workspace-observation' },
      quality: 'exact',
      completeness: 'complete',
      provisional: false,
      evidence: [],
      operation: 'retract',
      targetRecordId,
    });
  }

  expire(leaseId: string): void {
    this.push({ kind: 'lease-expired', runtimeRunId: RUN, runtimeEpoch: 1, leaseId, expiredAt: this.at() });
  }

  /** Delivers an earlier input again: a source identity's repeat is rejected. */
  replay(): void {
    if (this.last) this.steps.push({ input: this.last, asOf: this.at(this.pick(AS_OF_OFFSETS_MS)) });
  }

  private push(input: MonitorAccumulatorInput): void {
    this.last = input;
    this.steps.push({ input, asOf: this.at(this.pick(AS_OF_OFFSETS_MS)) });
  }
}

type Move = (s: Scenario) => void;

function response(s: Scenario, actor?: ActorRunRef): UsageFields {
  const input = s.int(4_000);
  const output = s.int(900);
  const priced = s.chance(0.7);
  return {
    origin: s.pick(['hook', 'telemetry', 'protocol'] as const),
    boundary: 'response',
    canonical: true,
    ...(s.chance(0.5) ? { totalTokens: input + output } : s.chance(0.5) ? { deltaTokens: input + output } : {}),
    ...(s.chance(0.4) ? { meterTokens: output + s.int(200) } : {}),
    inputTokens: input,
    outputTokens: output,
    ...(s.chance(0.3) ? { cacheReadTokens: s.int(2_000), freshInputTokens: input } : {}),
    ...(s.chance(0.2) ? { reasoningTokens: s.int(300) } : {}),
    ...(priced ? { costUsd: (input * 3 + output * 15) / 1_000_000 } : {}),
    ...(priced && s.chance(0.5)
      ? {
          cost: {
            basis: 'api-equivalent' as const,
            source: 'catalog' as const,
            inputUsd: (input * 3) / 1_000_000,
            outputUsd: (output * 15) / 1_000_000,
          },
        }
      : {}),
    ...(!priced && s.chance(0.5) ? { pricing: { providerId: 'anthropic', modelId: 'model-a' } } : {}),
    ...(actor ? { actor } : {}),
  };
}

const runtimeResponse: Move = (s) => {
  const id = s.id('u');
  s.runtimeUsage.push(id);
  s.runtime([usage(id, response(s))], s.chance(0.3) ? { identity: 'delivery' } : {});
};

/** A semantic response, sometimes for a usage id the runtime rail already holds (one claim per identity). */
const semanticResponse: Move = (s) => {
  const id = s.runtimeUsage.length > 0 && s.chance(0.3) ? s.pick(s.runtimeUsage) : s.id('u');
  s.semanticUsage.push(id);
  s.semantic([usage(id, response(s, s.pick(USAGE_ACTORS)))], s.chance(0.2) ? { effectiveAt: s.at(-5_000) } : {});
};

const correction: Move = (s) => {
  if (s.semanticUsage.length === 0) return semanticResponse(s);
  s.semantic([usage(s.pick(s.semanticUsage), response(s, s.pick(USAGE_ACTORS)))], { phase: 'correction' });
};

const usageRetract: Move = (s) => {
  const runtimeId = s.chance(0.5) ? s.take(s.runtimeUsage) : undefined;
  if (runtimeId) return s.runtime([retract('usage', runtimeId)]);
  const semanticId = s.take(s.semanticUsage);
  if (semanticId) return s.semantic([retract('usage', semanticId)]);
  runtimeResponse(s);
};

const usageSample: Move = (s) => {
  const actor = s.pick([undefined, ROOT, child('alpha'), child('beta')]);
  const fields = sample(s.count(actor?.runKey ?? 'root'), actor);
  if (s.chance(0.5)) s.runtime([usage(s.id('s'), fields)]);
  else s.semantic([usage(s.id('s'), fields)], { producer: 'semantic-b' });
};

const actorSample: Move = (s) => {
  const actor = s.pick([child('alpha'), child('beta'), LANE]);
  s.semantic([usage(s.id('s'), sample(s.count(actor.runKey), actor))], { producer: 'semantic-b' });
};

const rootSample: Move = (s) => {
  s.runtime([usage(s.id('s'), sample(s.count('root')))]);
};

/** Canonical cumulative counters with no per-response total. */
const canonicalCumulative: Move = (s) => {
  const actor = s.pick([undefined, child('alpha'), child('beta')]);
  s.semantic([usage(s.id('c'), sample(s.count(`canonical:${actor?.runKey ?? 'root'}`), actor, true))]);
};

/** Usage the ledger never admits: history, a reconstructed snapshot, an origin-less claim. */
const ignoredUsage: Move = (s) => {
  const id = s.id('x');
  switch (s.int(4)) {
    case 0:
      return s.runtime([usage(id, response(s))], { phase: 'bootstrap' });
    case 1:
      return s.semantic([
        replace('usage', [{ key: id, value: { kind: 'usage', usageId: id, ...response(s) } }], 'complete'),
      ]);
    case 2:
      return s.semantic([usage(id, { ...response(s), origin: undefined })]);
    default:
      return s.semantic([usage(id, response(s))], { producer: 'semantic-b', phase: 'bootstrap' });
  }
};

/** A child the run learns of only through its usage. */
const soloChild: Move = (s) => {
  s.semantic([usage(s.id('u'), response(s, child(`solo-${s.int(3)}`)))]);
};

/** An effective time that is not a timestamp: the ledger orders it first and never windows it. */
const untimedUsage: Move = (s) => {
  const id = s.id('u');
  s.runtimeUsage.push(id);
  s.runtime([usage(id, response(s))], { effectiveAt: 'not-a-time' });
};

const replay: Move = (s) => s.replay();

const message: Move = (s) => {
  const final = s.chance(0.3);
  s.runtime([
    final
      ? retract('status', 'responding')
      : activity('responding', 'responding', true, { line: 'Responding', since: s.at() }),
    upsert('conversation', 'message', { kind: 'message', text: s.id('reply'), final }),
  ]);
};

const turn: Move = (s) => {
  if (s.chance(0.5)) return s.runtime([activity('turn', 'other', true, { line: 'Working', since: s.at() })]);
  s.runtime([retract('status', 'turn'), retract('status', 'responding'), retract('status', 'reasoning')]);
};

const tool: Move = (s) => {
  s.runtime([activity(`tool-${s.int(3)}`, 'tool', s.chance(0.6), { line: 'bash', since: s.at() })]);
};

const prompt: Move = (s) => {
  const resolved = s.pending.length > 0 && s.chance(0.4) ? s.take(s.pending) : undefined;
  if (resolved) return s.runtime([permission(resolved, s.pick(['resolved', 'cancelled'] as const))]);
  const id = s.id('p');
  s.pending.push(id);
  s.runtime([permission(id, 'pending')]);
};

const ask: Move = (s) => {
  const id = s.id('q');
  s.pending.push(id);
  s.runtime([question(id, 'pending', [{ prompt: 'continue', options: options(2 + s.int(3)) }])]);
};

const failure: Move = (s) => {
  const id = `failure-${s.int(3)}`;
  s.runtime([
    upsert('status', id, {
      kind: 'failure',
      failureId: id,
      state: s.pick(['active', 'resolved', 'dismissed'] as const),
      recoverable: s.chance(0.5),
      detail: 'turn failed',
      code: 'turn-failed',
    }),
  ]);
};

const delegation: Move = (s) => {
  const id = s.pick(['alpha', 'gamma', 'delta']);
  switch (s.int(4)) {
    case 0:
      return s.semantic([
        upsert('delegation', `actor-${id}`, {
          kind: 'actor',
          actor: child(id),
          state: s.pick(['active', 'idle', 'stopped', 'unknown'] as const),
          activity: 'exploring',
        }),
      ]);
    case 1:
      return s.runtime([
        activity(`tool-${id}`, 'tool', s.chance(0.6), { actor: child(id), line: 'grep', since: s.at() }),
      ]);
    case 2:
      return s.runtime([permission(`child-${id}`, s.pick(['pending', 'resolved'] as const), child(id))]);
    default:
      return s.runtime([
        upsert('compaction', `compaction-${id}`, { kind: 'compaction', active: s.chance(0.5), actor: child(id) }),
      ]);
  }
};

const lease: Move = (s) => {
  if (s.leases.length > 0 && s.chance(0.4)) return s.expire(s.pick(s.leases));
  const leaseId = s.leases.length > 0 && s.chance(0.5) ? s.pick(s.leases) : s.id('lease');
  if (!s.leases.includes(leaseId)) s.leases.push(leaseId);
  s.semantic([activity('pulse', 'responding', true, { line: 'Streaming', leaseId })]);
};

const compaction: Move = (s) => {
  const active = s.chance(0.5);
  s.runtime(
    [
      upsert('compaction', 'current', {
        kind: 'compaction',
        active,
        trigger: 'auto',
        ...(active ? {} : { outcome: s.pick(['completed', 'cancelled'] as const) }),
      }),
    ],
    { provisional: s.chance(0.3) },
  );
};

const lifecycle: Move = (s) => {
  switch (s.int(4)) {
    case 0:
      return s.runtime([
        run('failed', false, { failure: { code: 'crash', detail: 'Process exited: crash', recoverable: false } }),
      ]);
    case 1:
      return s.runtime([run('exited', false)]);
    default:
      return s.runtime([run('running', true, { nativeSession: native(s.pick(['native-1', 'native-2'])) })]);
  }
};

const bootstrap: Move = (s) => {
  s.runtime([activity('turn', 'other', s.chance(0.5), { line: 'Replaying', since: s.at() })], { phase: 'bootstrap' });
};

function native(id: string) {
  return { namespace: 'native-hook', id, basis: 'observed' as const, quality: 'exact' as const };
}

function git(s: Scenario) {
  return { root: '/repo', branch: s.pick(['main', 'feature', null]), headSha: s.id('sha'), detached: s.chance(0.2) };
}

const cwd: Move = (s) => {
  s.runtime([
    upsert('environment', 'environment', {
      kind: 'environment',
      cwd: s.pick(['/repo', '/repo/sub', null]),
      ...(s.chance(0.5) ? { git: s.chance(0.2) ? null : git(s) } : {}),
    }),
  ]);
};

const worktrees: Move = (s) => {
  const count = s.pick([0, 3, 255, 256, 257, 300]);
  const paths = Array.from({ length: count }, () => `/repo/wt-${s.int(400).toString().padStart(3, '0')}`);
  s.semantic([upsert('environment', 'environment', { kind: 'environment', worktrees: paths })], {
    producer: 'semantic-b',
  });
};

const workspace: Move = (s) => {
  const retracted = s.chance(0.3) ? s.take(s.records) : undefined;
  if (retracted) return s.workspaceRetract(retracted);
  const recordId = s.id('record');
  s.records.push(recordId);
  s.workspace(recordId, {
    kind: 'environment',
    cwd: s.pick(['/repo', '/repo/wt-001']),
    ...(s.chance(0.5) ? { git: git(s) } : {}),
  });
};

const replacedEnvironment: Move = (s) => {
  s.semantic(
    [
      replace(
        'environment',
        [{ key: 'environment', value: { kind: 'environment', cwd: '/repo/replaced' } }],
        s.pick(['complete', 'partial'] as const),
      ),
    ],
    { producer: 'semantic-b' },
  );
};

const actorEnvironment: Move = (s) => {
  s.runtime([
    upsert('environment', 'environment-gamma', { kind: 'environment', actor: child('gamma'), cwd: '/child' }),
  ]);
};

const mode: Move = (s) => {
  const modeKind = s.pick(['provider-session', 'provider-permission'] as const);
  const intent = s.pick(['configured', 'observed'] as const);
  const update = upsert('mode', `${modeKind}-${intent}`, {
    kind: 'mode',
    modeKind,
    raw: s.pick(['default', 'plan', 'auto']),
    intent,
  });
  if (s.chance(0.5)) s.runtime([update]);
  else s.semantic([update]);
};

const model: Move = (s) => {
  const intent = s.pick(['configured', 'observed'] as const);
  const actor = s.chance(0.3) ? child('alpha') : undefined;
  const suffix = actor ? '-alpha' : '';
  s.runtime([
    upsert('model', `model-${intent}${suffix}`, {
      kind: 'model',
      providerModelId: s.pick(['model-a', 'model-b']),
      intent,
      ...(actor ? { actor } : {}),
    }),
    upsert('effort', `effort-${intent}${suffix}`, {
      kind: 'effort',
      value: s.pick(['low', 'high']),
      intent,
      ...(actor ? { actor } : {}),
    }),
  ]);
};

const context: Move = (s) => {
  s.semantic([
    upsert('context', 'root', {
      kind: 'context',
      usedTokens: s.int(200_000),
      capacityTokens: 200_000,
      ...(s.chance(0.5) ? { usedPercentage: s.int(100) } : {}),
      percentageSource: s.pick(['provider', 'derived'] as const),
    }),
  ]);
};

/** A staged replacement of semantic-c's slice, sometimes under a new epoch, then its ready barrier. */
const resync: Move = (s) => {
  if (s.chance(0.5)) s.epoch += 1;
  const epoch = `epoch-${s.epoch}`;
  s.semantic(
    [
      activity('status-c', 'reasoning', s.chance(0.5), { line: 'Thinking', since: s.at() }),
      upsert('model', 'observed', { kind: 'model', providerModelId: 'model-c', intent: 'observed' }),
      usage(s.id('u'), response(s)),
    ],
    { producer: 'semantic-c', epoch, phase: 'resync', readiness: 'loading', capabilities: CAPABILITIES },
  );
  if (s.chance(0.3)) return;
  s.tick();
  s.semantic([], {
    producer: 'semantic-c',
    epoch,
    phase: 'resync',
    readiness: 'ready',
    completeness: s.pick(['complete', 'partial'] as const),
    coverage: [
      { family: 'usage', completeness: s.pick(['complete', 'partial', 'unavailable'] as const), asOf: s.at() },
    ],
  });
};

/** semantic-c's usage under its current epoch, often an id an older epoch stored. */
const epochUsage: Move = (s) => {
  const id = s.epochUsage.length > 0 && s.chance(0.6) ? s.pick(s.epochUsage) : s.id('u');
  if (!s.epochUsage.includes(id)) s.epochUsage.push(id);
  s.semantic([usage(id, response(s, s.pick([undefined, child('alpha')])))], {
    producer: 'semantic-c',
    epoch: `epoch-${s.epoch}`,
  });
};

/** A batch from an epoch semantic-c has retired. */
const staleEpoch: Move = (s) => {
  s.semantic([usage(s.id('u'), response(s))], { producer: 'semantic-c', epoch: 'epoch-1' });
};

/** semantic-d orders its batches; a regressed sequence is rejected. */
const sequenced: Move = (s) => {
  s.sequence = Math.max(0, s.sequence + (s.chance(0.8) ? 1 : -1));
  s.semantic([upsert('model', 'observed', { kind: 'model', providerModelId: s.id('model'), intent: 'observed' })], {
    producer: 'semantic-d',
    sequence: s.sequence,
  });
};

const degraded: Move = (s) => {
  s.semantic([], {
    producer: 'semantic-b',
    readiness: s.pick(['degraded', 'ready'] as const),
    coverage: [
      {
        family: 'usage',
        completeness: s.pick(['partial', 'unavailable'] as const),
        asOf: s.at(-2_000),
        reason: 'counter gap',
      },
    ],
  });
};

/** A producer that declares usage unsupported while other rails still report it. */
const unsupportedUsage: Move = (s) => {
  s.semantic([usage(s.id('u'), response(s), 'shadow')], {
    producer: 'semantic-e',
    capabilities: [
      {
        family: 'usage',
        support: 'unsupported',
        actorScope: 'session',
        latency: 'historical',
        source: 'semantic-e',
        limitations: ['transcript only'],
      },
    ],
  });
};

/** Hundreds of canonical responses in one input: the public sample ring overflows. */
const bulkResponses: Move = (s) => {
  const updates = Array.from({ length: 260 }, (_, index) => {
    const id = `bulk-${index.toString().padStart(3, '0')}`;
    s.runtimeUsage.push(id);
    return usage(id, response(s, s.chance(0.2) ? child('alpha') : undefined));
  });
  s.runtime(updates);
};

/** Hundreds of samples in one input, from the root or from children alone. */
function bulkSamples(actors: readonly (ActorRunRef | undefined)[]): Move {
  return (s) => {
    s.runtime(
      Array.from({ length: 280 }, () => {
        const actor = s.pick(actors);
        return usage(s.id('s'), sample(s.count(actor?.runKey ?? 'root'), actor));
      }),
    );
  };
}

/** Seventy open permissions at once: beyond the blocker bound. */
const manyPermissions: Move = (s) => {
  s.runtime(
    Array.from({ length: 70 }, () => {
      const id = s.id('p');
      s.pending.push(id);
      return permission(id, 'pending');
    }),
  );
};

/** One question beyond the question bound, one of its questions beyond the option bound. */
const manyQuestions: Move = (s) => {
  const id = s.id('q');
  s.pending.push(id);
  s.runtime([
    question(
      id,
      'pending',
      Array.from({ length: 70 }, (_, index) => ({
        id: `question-${index.toString().padStart(3, '0')}`,
        prompt: 'choose',
        options: options(index === 3 ? 130 : 3),
        ...(index % 2 === 0 ? { allowMultiple: true } : {}),
      })),
    ),
  ]);
};

/** The run dies at its open prompts, then a new process takes the run over. */
const deathAtPrompt: Move = (s) => {
  s.runtime([
    run('failed', false, { failure: { code: 'signal', detail: 'Process exited: signal', recoverable: false } }),
  ]);
};

const revival: Move = (s) => {
  s.runtime([run('running', true, { nativeSession: native('native-3') })]);
};

/** Three hundred worktrees: beyond the worktree bound. */
const manyWorktrees: Move = (s) => {
  const paths = Array.from({ length: 300 }, (_, index) => `/repo/wt-${index.toString().padStart(3, '0')}`);
  s.semantic([upsert('environment', 'environment', { kind: 'environment', worktrees: paths })], {
    producer: 'semantic-b',
  });
};

/**
 * A key a producer reuses for another usage id leaves one identity on two claims; a later key for that identity
 * replaces the first stored of them.
 */
const reusedKey: Move = (s) => {
  s.semantic([usage('dup-1', response(s), 'kx-1'), usage('dup-2', response(s), 'kx-2')]);
  s.tick();
  s.semantic([usage('dup-1', response(s), 'kx-2')]);
  s.tick();
  s.semantic([usage('dup-1', response(s, child('beta')), 'kx-3')], { phase: 'correction' });
};

type Menu = Array<readonly [weight: number, move: Move]>;

function scenario(
  name: string,
  seed: number,
  length: number,
  menu: (step: number) => Menu,
  scripted: Record<number, Move> = {},
): Scenario {
  const s = new Scenario(name, seed);
  s.tick();
  s.runtime([run('starting', true)]);
  s.tick();
  s.runtime([run('running', true, { nativeSession: native('native-1') })]);
  for (let step = 0; step < length; step++) {
    s.tick();
    const script = scripted[step];
    if (script) {
      script(s);
      continue;
    }
    const choices = menu(step);
    let roll = s.int(choices.reduce((total, [weight]) => total + weight, 0));
    for (const [weight, move] of choices) {
      if (roll < weight) {
        move(s);
        break;
      }
      roll -= weight;
    }
  }
  return s;
}

const LEDGER: Menu = [
  [4, runtimeResponse],
  [4, semanticResponse],
  [2, correction],
  [2, usageRetract],
  [2, usageSample],
  [2, ignoredUsage],
  [2, soloChild],
  [1, untimedUsage],
  [1, replay],
  [2, message],
  [1, delegation],
];
const INTERACTIONS: Menu = [
  [4, prompt],
  [2, ask],
  [2, failure],
  [2, turn],
  [2, tool],
  [3, delegation],
  [3, lease],
  [2, compaction],
  [1, lifecycle],
  [1, bootstrap],
  [1, message],
];
const ENVIRONMENT: Menu = [
  [3, cwd],
  [3, worktrees],
  [3, workspace],
  [1, replacedEnvironment],
  [1, actorEnvironment],
  [2, mode],
  [2, model],
  [2, context],
  [1, message],
];
const RESYNC: Menu = [
  [2, resync],
  [4, epochUsage],
  [1, staleEpoch],
  [2, sequenced],
  [1, degraded],
  [2, runtimeResponse],
  [1, semanticResponse],
  [1, unsupportedUsage],
  [1, turn],
];

/** The samples sequence widens in phases: children alone, then a root stream, counters, and responses. */
const ROOT_SAMPLES: Menu = [[4, rootSample]];
const CANONICAL_COUNTERS: Menu = [[3, canonicalCumulative]];
const RESPONSES: Menu = [
  [3, runtimeResponse],
  [2, usageRetract],
];

function scenarios(): Scenario[] {
  return [
    scenario('ledger', 0x5eed01, 140, () => LEDGER, { 40: reusedKey, 60: bulkResponses }),
    scenario(
      'samples',
      0x5eed02,
      120,
      (step) => [
        [6, actorSample],
        ...(step >= 40 ? ROOT_SAMPLES : []),
        ...(step >= 70 ? CANONICAL_COUNTERS : []),
        ...(step >= 90 ? RESPONSES : []),
        [1, ignoredUsage],
      ],
      { 30: bulkSamples([child('alpha'), child('beta')]), 60: bulkSamples([undefined, child('alpha')]) },
    ),
    scenario('interactions', 0x5eed03, 100, () => INTERACTIONS, {
      25: manyPermissions,
      45: manyQuestions,
      70: deathAtPrompt,
      74: revival,
    }),
    scenario('environment', 0x5eed04, 80, () => ENVIRONMENT, { 20: manyWorktrees }),
    scenario('resync', 0x5eed05, 80, () => RESYNC),
    scenario('mixed', 0x5eed06, 160, () => [...LEDGER, ...INTERACTIONS, ...ENVIRONMENT, ...RESYNC], {
      50: bulkResponses,
      90: manyPermissions,
    }),
  ];
}

function initial(): MonitorAccumulatorState {
  return createMonitorAccumulatorState({
    runtimeRunId: RUN,
    runtimeEpoch: 1,
    executionMode: 'native-tui',
    observationLevel: 'native-hooks',
    allocatedAt: new Date(T0).toISOString(),
    providerId: 'claude',
  });
}

interface StepRecord {
  accepted: boolean;
  notifications: MonitorNotification[];
  bounded: string;
  unbounded: string;
}

interface SequenceRecord {
  steps: StepRecord[];
  /** The last bounded projection in full, so a divergence reads as a diff and not only a digest. */
  final: AgentMonitorState;
}

interface GoldenDocument {
  schemaVersion: 1;
  sequences: Record<string, SequenceRecord>;
}

function digest(state: AgentMonitorState): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function record(s: Scenario): SequenceRecord {
  let state = initial();
  let bounded = projectAgentMonitorState(state, { asOf: state.allocatedAt });
  let unbounded = projectAgentMonitorState(state, {
    asOf: state.allocatedAt,
    burnRateWindowMs: WIDE_WINDOW_MS,
    unboundedCollections: true,
  });
  const steps = s.steps.map(({ input, asOf }): StepRecord => {
    const reduced = reduceMonitorAccumulator(state, input);
    state = reduced.state;
    bounded = projectAgentMonitorState(state, { previous: bounded, asOf });
    unbounded = projectAgentMonitorState(state, {
      previous: unbounded,
      asOf,
      burnRateWindowMs: WIDE_WINDOW_MS,
      unboundedCollections: true,
    });
    return {
      accepted: reduced.accepted,
      notifications: reduced.notifications,
      bounded: digest(bounded),
      unbounded: digest(unbounded),
    };
  });
  return { steps, final: bounded };
}

/** The canonical text, written and compared as the surface ground truth is: two-space JSON and a newline. */
function canonicalGolden(): string {
  const document: GoldenDocument = {
    schemaVersion: 1,
    sequences: Object.fromEntries(scenarios().map((s) => [s.name, record(s)])),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** One live runtime input carrying `count` canonical responses: a ledger of any size at one reduce's cost. */
function ledgerOf(count: number): RuntimeMonitorInput {
  return {
    kind: 'runtime',
    schemaVersion: 1,
    eventId: `ledger-${count}`,
    runtimeRunId: RUN,
    runtimeEpoch: 1,
    phase: 'live',
    observedAt: new Date(T0 + 1_000).toISOString(),
    source: { id: 'native-hook', kind: 'agent-event' },
    quality: 'exact',
    completeness: 'complete',
    provisional: false,
    updates: Array.from({ length: count }, (_, index) =>
      usage(`response-${index.toString().padStart(4, '0')}`, {
        origin: 'hook',
        boundary: 'response',
        canonical: true,
        totalTokens: 100,
        costUsd: 0.001,
      }),
    ),
    evidence: [],
  };
}

/** One streamed assistant delta, as the runtime translates it. */
function streamedDelta(): RuntimeMonitorInput {
  const event: AgentEvent = { type: 'conversation:assistant-message', text: 'Working on it', final: false };
  const envelope: AgentEventEnvelope = {
    type: agentEventType(event),
    category: agentEventCategory(event),
    sequence: 2,
    sessionId: 'terminal-1',
    nativeSessionId: 'native-1',
    timestamp: new Date(T0 + 2_000).toISOString(),
    monotonicTime: 2,
    source: 'native-hook',
    confidence: 'authoritative',
    event,
  };
  return translateAgentEventEnvelope({ runtimeRunId: RUN, runtimeEpoch: 1, identity: 'delivery', envelope });
}

/** A clone shares no object with the state, so no memo filled for the state can answer for it. */
function fresh(state: MonitorAccumulatorState): MonitorAccumulatorState {
  // The seen-identity sets are persistent trees no projection reads; a structured clone would flatten them.
  return structuredClone({
    ...state,
    runtime: { ...state.runtime, seenEventIds: new Set<string>() },
    semantic: { ...state.semantic, seenBatchIds: new Set<string>() },
    workspace: { ...state.workspace, seenRecordIds: new Set<string>() },
  });
}

describe('monitor projection cost', () => {
  it('reproduces the projections recorded before the refactor, byte for byte', () => {
    const actual = canonicalGolden();
    if (process.env[WRITE_FLAG] === '1') {
      writeFileSync(GOLDEN_PATH, actual);
      console.log(`wrote ${GOLDEN_PATH}`);
      return;
    }
    if (!existsSync(GOLDEN_PATH)) {
      throw new Error(`${GOLDEN_PATH}: missing projection-equivalence golden; record it with ${WRITE_FLAG}=1`);
    }
    const golden = readFileSync(GOLDEN_PATH, 'utf8');
    if (actual !== golden) {
      // Name the first divergence before failing on the bytes.
      const expected = JSON.parse(golden) as GoldenDocument;
      const received = JSON.parse(actual) as GoldenDocument;
      for (const [name, sequence] of Object.entries(expected.sequences)) {
        const steps = received.sequences[name]?.steps ?? [];
        sequence.steps.forEach((step, index) => expect(steps[index], `${name} step ${index}`).toEqual(step));
        expect(received.sequences[name]?.final, `${name} final projection`).toEqual(sequence.final);
      }
    }
    expect(actual, `${GOLDEN_PATH}: stale projection-equivalence golden`).toBe(golden);
  }, 120_000);

  it('reduces a streamed delta at a cost the size of the usage ledger does not set', () => {
    const parsesFor = (count: number) => {
      const ledger = reduceMonitorAccumulator(initial(), ledgerOf(count)).state;
      expect(ledger.usage.entries.size).toBe(count);
      const delta = streamedDelta();
      const parse = vi.spyOn(Date, 'parse');
      const reduced = reduceMonitorAccumulator(ledger, delta);
      const parses = parse.mock.calls.length;
      parse.mockRestore();
      expect(reduced.accepted).toBe(true);
      return parses;
    };
    expect(parsesFor(2_000)).toBe(parsesFor(200));
  });

  it("derives a streamed delta's notifications without projecting the full monitor state", () => {
    const ledger = reduceMonitorAccumulator(initial(), ledgerOf(200)).state;
    const project = vi.spyOn(projection, 'projectAgentMonitorState');
    const reduced = reduceMonitorAccumulator(ledger, streamedDelta());
    const projections = project.mock.calls.length;
    project.mockRestore();
    expect(reduced.accepted).toBe(true);
    expect(projections).toBe(0);
  });

  it('projects every state as it projects a fresh copy of it, so no memo answers for a state it did not see', () => {
    for (const s of scenarios()) {
      let state = initial();
      s.steps.forEach(({ input, asOf }, index) => {
        state = reduceMonitorAccumulator(state, input).state;
        const options = { asOf, unboundedCollections: index % 2 === 1 };
        expect(projectAgentMonitorState(state, options), `${s.name} step ${index}`).toEqual(
          projectAgentMonitorState(fresh(state), options),
        );
      });
    }
  }, 120_000);
});
