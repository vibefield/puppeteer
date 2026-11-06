import { EventIdSet, withEventId } from './event-id-set.js';
import type {
  AgentEventEnvelope,
  AgentEventConfidence,
  EffortUpdatedEvent,
  EnvironmentUpdatedEvent,
  ModeUpdatedEvent,
  ModelUpdatedEvent,
  ProcessExitReason,
} from '../events/index.js';
import type {
  ActorRunRef,
  EvidenceCompleteness,
  EvidenceQuality,
  MonitorMetricFamily,
  NativeSessionRef,
} from './types.js';
import type {
  CreateMonitorAccumulatorOptions,
  EvidenceRef,
  EvidenceSource,
  MonitorAccumulatorInput,
  MonitorAccumulatorState,
  MonitorActivityObservation,
  MonitorEnvironmentFamilyValue,
  MonitorEvidencePlane,
  MonitorFamilyUpsert,
  MonitorFamilyUpdate,
  MonitorFamilyValueMap,
  MonitorObservationPhase,
  ObservationCoverage,
  MonitorReduceResult,
  MonitorRunStatusObservation,
  MonitorSemanticProducerState,
  MonitorStoredEntry,
  MonitorUsageSlice,
  RuntimeMonitorInput,
  RuntimeMonitorObservationBatch,
  SourceWatermark,
  WorkspaceMonitorObservation,
} from './internal-types.js';
import { deriveMonitorNotifications } from './notifications.js';
import { liveUsageOrigin, permitsLiveUsage } from './usage-policy.js';

interface StoredEntryContext {
  plane: MonitorEvidencePlane;
  ownerId: string;
  ownerEpoch: string;
  scopeKey: string;
  observedAt: string;
  effectiveAt?: string;
  source: EvidenceSource;
  quality: EvidenceQuality;
  completeness: EvidenceCompleteness;
  provisional: boolean;
  phase: MonitorObservationPhase;
  evidence: EvidenceRef[];
}

interface AppliedUpdates {
  entries: Map<string, MonitorStoredEntry>;
  usage: MonitorUsageSlice;
  compactionStarts: number;
}

/** One input's copy of the usage slice, made on its first usage update that applies. */
interface UsageLedgerDraft {
  entries: Map<string, MonitorStoredEntry>;
  byOwnerUsageId: Map<string, ReadonlySet<string>>;
}

export interface TranslateAgentEventOptions {
  runtimeRunId: string;
  runtimeEpoch: number;
  envelope: AgentEventEnvelope;
  /** Who minted `envelope.eventId` (see `RuntimeMonitorInput.identity`); the minting package says so. */
  identity?: RuntimeMonitorInput['identity'];
}

function storageKey(
  context: Pick<StoredEntryContext, 'plane' | 'ownerId' | 'ownerEpoch' | 'scopeKey'>,
  family: string,
  key: string,
): string {
  return JSON.stringify([context.plane, context.ownerId, context.ownerEpoch, context.scopeKey, family, key]);
}

function scopeKey(scope: RuntimeMonitorObservationBatch['scope']): string {
  return JSON.stringify([scope?.nativeSessionId ?? '', scope?.actorRunKey ?? '']);
}

function asRun(value: MonitorFamilyValueMap[MonitorMetricFamily]): MonitorRunStatusObservation | undefined {
  return value.kind === 'run' ? value : undefined;
}

function asActivity(value: MonitorFamilyValueMap[MonitorMetricFamily]): MonitorActivityObservation | undefined {
  return value.kind === 'activity' ? value : undefined;
}

function mergeStoredValue(existing: MonitorStoredEntry | undefined, value: MonitorFamilyValueMap[MonitorMetricFamily]) {
  if (!existing) return value;
  const priorRun = asRun(existing.value);
  const nextRun = asRun(value);
  if (priorRun && nextRun) {
    return {
      ...priorRun,
      ...nextRun,
      nativeSession: nextRun.nativeSession ?? priorRun.nativeSession,
      failure: nextRun.failure ?? priorRun.failure,
    } satisfies MonitorRunStatusObservation;
  }
  if (existing.value.kind === 'environment' && value.kind === 'environment') {
    const merged: MonitorEnvironmentFamilyValue = { ...existing.value, ...value };
    if (value.cwd !== undefined && value.cwd !== existing.value.cwd && value.git === undefined) delete merged.git;
    return merged;
  }
  return value;
}

function storedEntry(
  context: StoredEntryContext,
  family: MonitorMetricFamily,
  key: string,
  value: MonitorFamilyValueMap[MonitorMetricFamily],
  existing?: MonitorStoredEntry,
): MonitorStoredEntry {
  const correction = context.phase === 'correction' && existing !== undefined;
  // Usage keys identify one response/sample observation. Providers may repeat
  // older members while publishing a replacement snapshot; learning the same
  // observation again must not move its rate timestamp to the newest poll.
  const repeatedUsageIdentity =
    existing?.value.kind === 'usage' && value.kind === 'usage' && existing.value.usageId === value.usageId;
  const preserveRateBoundary = correction || repeatedUsageIdentity;
  const effectiveAt =
    context.effectiveAt ?? (repeatedUsageIdentity ? (existing.effectiveAt ?? existing.observedAt) : undefined);
  const rateAt = preserveRateBoundary
    ? (existing?.rateAt ?? existing?.effectiveAt ?? existing?.observedAt)
    : (context.effectiveAt ?? context.observedAt);
  const entry: MonitorStoredEntry = {
    storageKey: storageKey(context, family, key),
    plane: context.plane,
    ownerId: context.ownerId,
    ownerEpoch: context.ownerEpoch,
    scopeKey: context.scopeKey,
    family,
    key,
    value: mergeStoredValue(existing, value),
    observedAt: context.observedAt,
    ...(effectiveAt ? { effectiveAt } : {}),
    source: context.source,
    quality: context.quality,
    completeness: context.completeness,
    provisional: context.provisional,
    phase: context.phase,
    evidence: context.evidence,
    rateEligible: preserveRateBoundary
      ? (existing?.rateEligible ?? false)
      : context.phase === 'live' && value.kind === 'usage',
    ...(rateAt ? { rateAt } : {}),
  };
  const at = Date.parse(entry.rateAt ?? entry.effectiveAt ?? entry.observedAt);
  entry.timeMs = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
  return entry;
}

function ownedBy(entry: MonitorStoredEntry, context: StoredEntryContext, family: MonitorMetricFamily): boolean {
  return (
    entry.plane === context.plane &&
    entry.ownerId === context.ownerId &&
    entry.ownerEpoch === context.ownerEpoch &&
    entry.scopeKey === context.scopeKey &&
    entry.family === family
  );
}

function usageIdentity(plane: MonitorEvidencePlane, ownerId: string, usageId: string): string {
  return JSON.stringify([plane, ownerId, usageId]);
}

function identityOf(entry: MonitorStoredEntry): string {
  return usageIdentity(entry.plane, entry.ownerId, entry.value.kind === 'usage' ? entry.value.usageId : '');
}

function draftUsage(usage: MonitorUsageSlice): UsageLedgerDraft {
  return { entries: new Map(usage.entries), byOwnerUsageId: new Map(usage.byOwnerUsageId) };
}

function unindexUsage(draft: UsageLedgerDraft, entry: MonitorStoredEntry): void {
  const identity = identityOf(entry);
  const keys = draft.byOwnerUsageId.get(identity);
  if (!keys?.has(entry.storageKey)) return;
  if (keys.size === 1) {
    draft.byOwnerUsageId.delete(identity);
    return;
  }
  const remaining = new Set(keys);
  remaining.delete(entry.storageKey);
  draft.byOwnerUsageId.set(identity, remaining);
}

function setUsage(draft: UsageLedgerDraft, entry: MonitorStoredEntry): void {
  const prior = draft.entries.get(entry.storageKey);
  if (prior) unindexUsage(draft, prior);
  draft.entries.set(entry.storageKey, entry);
  const identity = identityOf(entry);
  draft.byOwnerUsageId.set(identity, new Set(draft.byOwnerUsageId.get(identity)).add(entry.storageKey));
}

function deleteUsage(draft: UsageLedgerDraft, key: string): void {
  const prior = draft.entries.get(key);
  if (!prior) return;
  unindexUsage(draft, prior);
  draft.entries.delete(key);
}

/** The claim an owner already holds for a usage id, whatever epoch or scope stored it. */
function ownedUsage(draft: UsageLedgerDraft, context: StoredEntryContext, usageId: string) {
  const keys = draft.byOwnerUsageId.get(usageIdentity(context.plane, context.ownerId, usageId));
  if (!keys) return undefined;
  // A key reused for another usage id can leave one identity on two claims; the first stored answers, as a
  // scan of the plane in its order did.
  if (keys.size > 1) {
    for (const [key, entry] of draft.entries) if (keys.has(key)) return entry;
  }
  for (const key of keys) return draft.entries.get(key);
  return undefined;
}

function applyUpdates(
  current: ReadonlyMap<string, MonitorStoredEntry>,
  usage: MonitorUsageSlice,
  updates: readonly MonitorFamilyUpdate[],
  context: StoredEntryContext,
): AppliedUpdates {
  const entries = new Map(current);
  let ledger: UsageLedgerDraft | undefined;
  let compactionStarts = 0;

  for (const update of updates) {
    // A history refresh must not even retract or replace live accounting.
    if (update.family === 'usage') {
      if (context.phase !== 'live' && context.phase !== 'correction') continue;
      if (update.operation === 'upsert' && !permitsLiveUsage(context.phase, update.value.origin)) continue;
      if (update.operation === 'replace') {
        // Usage is an observation ledger, never a reconstructed snapshot.
        continue;
      }
      // The ledger lives apart from the planes and is copied only when a usage update applies.
      ledger ??= draftUsage(usage);
      const key = storageKey(context, update.family, update.key);
      if (update.operation === 'retract') {
        deleteUsage(ledger, key);
        continue;
      }
      // A producer may reconnect under a new epoch. The observation identity
      // still refers to the original work, so its rate timestamp must survive.
      const existing = ledger.entries.get(key) ?? ownedUsage(ledger, context, update.value.usageId);
      if (existing && existing.storageKey !== key) deleteUsage(ledger, existing.storageKey);
      setUsage(ledger, storedEntry(context, update.family, update.key, update.value, existing));
      continue;
    }
    if (update.operation === 'retract') {
      entries.delete(storageKey(context, update.family, update.key));
      continue;
    }

    if (update.operation === 'replace') {
      const prior = new Map(entries);
      if (update.coverage === 'complete') {
        for (const [key, entry] of entries) {
          if (ownedBy(entry, context, update.family)) entries.delete(key);
        }
      }
      for (const replacement of update.values) {
        const key = storageKey(context, update.family, replacement.key);
        entries.set(key, storedEntry(context, update.family, replacement.key, replacement.value, prior.get(key)));
      }
      continue;
    }

    const key = storageKey(context, update.family, update.key);
    const existing = entries.get(key);
    if (
      context.phase === 'live' &&
      update.family === 'compaction' &&
      update.value.kind === 'compaction' &&
      update.value.active &&
      (existing?.value.kind !== 'compaction' || !existing.value.active)
    ) {
      compactionStarts += 1;
    }
    entries.set(key, storedEntry(context, update.family, update.key, update.value, existing));
  }

  return { entries, usage: ledger ?? usage, compactionStarts };
}

function initialRunEntry(options: CreateMonitorAccumulatorOptions): MonitorStoredEntry {
  const context: StoredEntryContext = {
    plane: 'runtime',
    ownerId: 'runtime',
    ownerEpoch: String(options.runtimeEpoch),
    scopeKey: '',
    observedAt: options.allocatedAt,
    source: { id: 'runtime', kind: 'runtime-allocation' },
    quality: 'exact',
    completeness: 'complete',
    provisional: false,
    phase: 'bootstrap',
    evidence: [],
  };
  return storedEntry(context, 'status', 'run', { kind: 'run', lifecycle: 'allocated', alive: true });
}

export function createMonitorAccumulatorState(options: CreateMonitorAccumulatorOptions): MonitorAccumulatorState {
  if (!Number.isSafeInteger(options.runtimeEpoch) || options.runtimeEpoch < 1) {
    throw new RangeError('monitor runtimeEpoch must be a positive safe integer');
  }
  if (!Number.isFinite(Date.parse(options.allocatedAt))) {
    throw new RangeError('monitor allocatedAt must be an ISO-compatible timestamp');
  }
  const run = initialRunEntry(options);
  return {
    schemaVersion: 1,
    runtimeRunId: options.runtimeRunId,
    runtimeEpoch: options.runtimeEpoch,
    executionMode: options.executionMode,
    observationLevel: options.observationLevel,
    allocatedAt: options.allocatedAt,
    ...(options.providerId ? { providerId: options.providerId } : {}),
    ...(options.terminalSessionId ? { terminalSessionId: options.terminalSessionId } : {}),
    runtime: { seenEventIds: new EventIdSet(), entries: new Map([[run.storageKey, run]]) },
    semantic: { seenBatchIds: new EventIdSet(), producers: new Map(), entries: new Map(), resyncs: new Map() },
    workspace: { seenRecordIds: new EventIdSet(), entries: new Map(), provenance: new Map() },
    usage: { entries: new Map(), byOwnerUsageId: new Map() },
    expiredLeaseIds: new Set(),
    compactionCount: 0,
  };
}

function withRefreshedLeases(
  expiredLeaseIds: ReadonlySet<string>,
  entries: ReadonlyMap<string, MonitorStoredEntry>,
): ReadonlySet<string> {
  let next: Set<string> | undefined;
  for (const entry of entries.values()) {
    const activity = asActivity(entry.value);
    if (!activity?.active || !activity.leaseId || !expiredLeaseIds.has(activity.leaseId)) continue;
    next ??= new Set(expiredLeaseIds);
    next.delete(activity.leaseId);
  }
  return next ?? expiredLeaseIds;
}

function rejected(state: MonitorAccumulatorState): MonitorReduceResult {
  return { state, notifications: [], accepted: false };
}

function latestAccepted(current: string | undefined, candidate: string): string {
  if (current === undefined) return candidate;
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(currentMs)) return candidate;
  if (!Number.isFinite(candidateMs)) return current;
  return candidateMs > currentMs ? candidate : current;
}

// A notification id names its input, and an input arrives here once (deduplicated, or unique by
// construction), so no set of emitted ids is kept.
function finishAccepted(
  previous: MonitorAccumulatorState,
  next: MonitorAccumulatorState,
  input: MonitorAccumulatorInput,
): MonitorReduceResult {
  return { state: next, notifications: deriveMonitorNotifications(previous, next, input), accepted: true };
}

function reduceRuntime(state: MonitorAccumulatorState, input: RuntimeMonitorInput): MonitorReduceResult {
  // A delivery identity cannot repeat, so only a source identity is checked and retained.
  const sourced = input.identity !== 'delivery';
  if (sourced && state.runtime.seenEventIds.has(input.eventId)) return rejected(state);
  const context: StoredEntryContext = {
    plane: 'runtime',
    ownerId: 'runtime',
    ownerEpoch: String(input.runtimeEpoch),
    scopeKey: '',
    observedAt: input.observedAt,
    ...(input.effectiveAt ? { effectiveAt: input.effectiveAt } : {}),
    source: input.source,
    quality: input.quality,
    completeness: input.completeness,
    provisional: input.provisional,
    phase: input.phase,
    evidence: input.evidence,
  };
  const applied = applyUpdates(state.runtime.entries, state.usage, input.updates, context);
  const seenEventIds = sourced ? withEventId(state.runtime.seenEventIds, input.eventId) : state.runtime.seenEventIds;
  const next: MonitorAccumulatorState = {
    ...state,
    runtime: {
      seenEventIds,
      entries: applied.entries,
      lastAcceptedAt: latestAccepted(state.runtime.lastAcceptedAt, input.observedAt),
    },
    usage: applied.usage,
    expiredLeaseIds: withRefreshedLeases(state.expiredLeaseIds, applied.entries),
    compactionCount: state.compactionCount + applied.compactionStarts,
  };
  return finishAccepted(state, next, input);
}

function watermarkKey(watermark: SourceWatermark): string {
  return JSON.stringify([watermark.sourceId, watermark.sourceEpoch]);
}

function coverageKey(coverage: ObservationCoverage): string {
  return JSON.stringify([coverage.family, coverage.actor?.runKey ?? '']);
}

function newProducer(batch: RuntimeMonitorObservationBatch): MonitorSemanticProducerState {
  return {
    id: batch.producer.id,
    activeEpoch: batch.producer.epoch,
    retiredEpochs: new Set(),
    ...(batch.producer.sequence !== undefined ? { lastSequence: batch.producer.sequence } : {}),
    readiness: batch.readiness ?? (batch.phase === 'bootstrap' ? 'loading' : 'ready'),
    capabilities: new Map((batch.capabilities ?? []).map((capability) => [capability.family, capability])),
    coverage: new Map((batch.coverage ?? []).map((coverage) => [coverageKey(coverage), coverage])),
    watermarks: new Map(batch.sourceWatermarks.map((watermark) => [watermarkKey(watermark), watermark])),
  };
}

function updateProducer(
  current: MonitorSemanticProducerState,
  batch: RuntimeMonitorObservationBatch,
  switchedEpoch: boolean,
): MonitorSemanticProducerState {
  const retiredEpochs = new Set(current.retiredEpochs);
  if (switchedEpoch) retiredEpochs.add(current.activeEpoch);
  const capabilities = switchedEpoch ? new Map() : new Map(current.capabilities);
  for (const capability of batch.capabilities ?? []) capabilities.set(capability.family, capability);
  const coverage = switchedEpoch ? new Map() : new Map(current.coverage);
  for (const item of batch.coverage ?? []) coverage.set(coverageKey(item), item);
  const watermarks = switchedEpoch ? new Map() : new Map(current.watermarks);
  for (const watermark of batch.sourceWatermarks) watermarks.set(watermarkKey(watermark), watermark);
  return {
    id: current.id,
    activeEpoch: batch.producer.epoch,
    retiredEpochs,
    ...(batch.producer.sequence !== undefined
      ? { lastSequence: batch.producer.sequence }
      : !switchedEpoch && current.lastSequence !== undefined
        ? { lastSequence: current.lastSequence }
        : {}),
    readiness: batch.readiness ?? (batch.phase === 'bootstrap' ? 'loading' : 'ready'),
    capabilities,
    coverage,
    watermarks,
  };
}

function beginResyncProducer(
  current: MonitorSemanticProducerState | undefined,
  batch: RuntimeMonitorObservationBatch,
): MonitorSemanticProducerState {
  const switchedEpoch = current !== undefined && current.activeEpoch !== batch.producer.epoch;
  const retiredEpochs = new Set(current?.retiredEpochs ?? []);
  if (switchedEpoch) retiredEpochs.add(current.activeEpoch);
  const capabilities = switchedEpoch ? new Map() : new Map(current?.capabilities ?? []);
  for (const capability of batch.capabilities ?? []) capabilities.set(capability.family, capability);
  const coverage = switchedEpoch ? new Map() : new Map(current?.coverage ?? []);
  for (const item of batch.coverage ?? []) coverage.set(coverageKey(item), item);
  const watermarks = switchedEpoch ? new Map() : new Map(current?.watermarks ?? []);
  for (const watermark of batch.sourceWatermarks) watermarks.set(watermarkKey(watermark), watermark);
  return {
    id: batch.producer.id,
    activeEpoch: batch.producer.epoch,
    retiredEpochs,
    ...(batch.producer.sequence !== undefined ? { lastSequence: batch.producer.sequence } : {}),
    readiness: batch.readiness ?? 'ready',
    capabilities,
    coverage,
    watermarks,
  };
}

function reduceSemantic(state: MonitorAccumulatorState, batch: RuntimeMonitorObservationBatch): MonitorReduceResult {
  const batchIdentity = JSON.stringify([batch.producer.id, batch.producer.epoch, batch.batchId]);
  if (state.semantic.seenBatchIds.has(batchIdentity)) return rejected(state);

  const currentProducer = state.semantic.producers.get(batch.producer.id);
  const pendingBefore = state.semantic.resyncs.get(batch.producer.id);
  const orderingProducer = pendingBefore?.producer ?? currentProducer;
  const switchedEpoch = orderingProducer !== undefined && orderingProducer.activeEpoch !== batch.producer.epoch;
  if (orderingProducer?.retiredEpochs.has(batch.producer.epoch)) return rejected(state);
  if (switchedEpoch && batch.phase !== 'resync') return rejected(state);
  if (
    !switchedEpoch &&
    orderingProducer?.lastSequence !== undefined &&
    batch.producer.sequence !== undefined &&
    batch.producer.sequence <= orderingProducer.lastSequence
  ) {
    return rejected(state);
  }

  const context: StoredEntryContext = {
    plane: 'semantic',
    ownerId: batch.producer.id,
    ownerEpoch: batch.producer.epoch,
    scopeKey: scopeKey(batch.scope),
    observedAt: batch.observedAt,
    ...(batch.effectiveAt ? { effectiveAt: batch.effectiveAt } : {}),
    source: {
      id: batch.producer.id,
      kind: 'adapter-monitor',
      ...(batch.producer.contractVersion ? { contractVersion: batch.producer.contractVersion } : {}),
    },
    quality: batch.quality,
    completeness: batch.completeness,
    provisional: batch.provisional,
    phase: batch.phase,
    evidence: batch.evidence,
  };
  const producers = new Map(state.semantic.producers);
  const seenBatchIds = withEventId(state.semantic.seenBatchIds, batchIdentity);
  const resyncs = new Map(state.semantic.resyncs);
  let semanticEntries = new Map(state.semantic.entries);
  let usage = state.usage;
  let compactionStarts = 0;

  if (batch.phase === 'resync') {
    const pending = resyncs.get(batch.producer.id);
    const stagingBase =
      pending?.epoch === batch.producer.epoch ? pending.entries : new Map<string, MonitorStoredEntry>();
    // A resync never reaches the ledger: applyUpdates admits usage only from live and correction phases.
    const applied = applyUpdates(stagingBase, state.usage, batch.updates, context);
    const stagedCompactionStarts =
      (pending?.epoch === batch.producer.epoch ? pending.compactionStarts : 0) + applied.compactionStarts;
    const stagedProducer =
      pending?.epoch === batch.producer.epoch
        ? updateProducer(pending.producer, batch, false)
        : beginResyncProducer(currentProducer, batch);
    if (stagedProducer.readiness === 'loading') {
      resyncs.set(batch.producer.id, {
        epoch: batch.producer.epoch,
        entries: applied.entries,
        compactionStarts: stagedCompactionStarts,
        producer: stagedProducer,
      });
      // Keep committed capabilities/coverage visible while explicitly
      // reporting loading; the staged metadata becomes authoritative only at
      // the ready barrier.
      producers.set(
        batch.producer.id,
        currentProducer
          ? {
              ...currentProducer,
              activeEpoch: stagedProducer.activeEpoch,
              retiredEpochs: stagedProducer.retiredEpochs,
              ...(stagedProducer.lastSequence !== undefined ? { lastSequence: stagedProducer.lastSequence } : {}),
              readiness: 'loading',
            }
          : stagedProducer,
      );
    } else {
      // A complete ready barrier replaces the full producer slice. Partial or
      // unavailable coverage may add/correct facts but cannot erase old ones.
      // The usage ledger is not in the slice, so a barrier never erases it.
      if (batch.completeness === 'complete') {
        for (const [key, entry] of semanticEntries) {
          if (entry.ownerId === batch.producer.id) semanticEntries.delete(key);
        }
      }
      for (const [key, entry] of applied.entries) semanticEntries.set(key, entry);
      compactionStarts = stagedCompactionStarts;
      resyncs.delete(batch.producer.id);
      producers.set(batch.producer.id, stagedProducer);
    }
  } else {
    // A live/correction delivery ends an abandoned replacement attempt while
    // preserving the last committed semantic slice.
    resyncs.delete(batch.producer.id);
    const applied = applyUpdates(semanticEntries, state.usage, batch.updates, context);
    semanticEntries = applied.entries;
    usage = applied.usage;
    compactionStarts = applied.compactionStarts;
    const producer = currentProducer ? updateProducer(currentProducer, batch, switchedEpoch) : newProducer(batch);
    producers.set(batch.producer.id, producer);
  }

  const next: MonitorAccumulatorState = {
    ...state,
    semantic: {
      seenBatchIds,
      producers,
      entries: semanticEntries,
      resyncs,
      lastAcceptedAt: latestAccepted(state.semantic.lastAcceptedAt, batch.observedAt),
    },
    usage,
    expiredLeaseIds: withRefreshedLeases(state.expiredLeaseIds, semanticEntries),
    compactionCount: state.compactionCount + compactionStarts,
  };
  return finishAccepted(state, next, batch);
}

function reduceWorkspace(state: MonitorAccumulatorState, input: WorkspaceMonitorObservation): MonitorReduceResult {
  if (state.workspace.seenRecordIds.has(input.recordId)) return rejected(state);
  const context: StoredEntryContext = {
    plane: 'workspace',
    ownerId: 'workspace',
    ownerEpoch: String(input.runtimeEpoch),
    scopeKey: '',
    observedAt: input.observedAt,
    ...(input.effectiveAt ? { effectiveAt: input.effectiveAt } : {}),
    source: input.source,
    quality: input.quality,
    completeness: input.completeness,
    provisional: input.provisional,
    phase: 'live',
    evidence: input.evidence,
  };
  const entries = new Map(state.workspace.entries);
  const provenance = new Map(state.workspace.provenance);
  if (input.operation === 'provenance') {
    provenance.set(input.value.workspaceInstanceId, input.value);
  } else if (input.operation === 'retract') {
    entries.delete(storageKey(context, 'environment', input.targetRecordId));
  } else {
    const key = storageKey(context, 'environment', input.recordId);
    entries.set(key, storedEntry(context, 'environment', input.recordId, input.value, entries.get(key)));
  }
  const seenRecordIds = withEventId(state.workspace.seenRecordIds, input.recordId);
  const next: MonitorAccumulatorState = {
    ...state,
    workspace: {
      seenRecordIds,
      entries,
      provenance,
      lastAcceptedAt: latestAccepted(state.workspace.lastAcceptedAt, input.observedAt),
      ...(input.operation === 'provenance'
        ? {}
        : { lastPublicAcceptedAt: latestAccepted(state.workspace.lastPublicAcceptedAt, input.observedAt) }),
    },
  };
  return finishAccepted(state, next, input);
}

function expireLeases(
  state: MonitorAccumulatorState,
  input: Extract<MonitorAccumulatorInput, { kind: 'lease-expired' }>,
) {
  if (state.expiredLeaseIds.has(input.leaseId)) return rejected(state);
  const remove = (entries: ReadonlyMap<string, MonitorStoredEntry>) => {
    const next = new Map(entries);
    for (const [key, entry] of next) {
      const activity = asActivity(entry.value);
      if (activity?.leaseId === input.leaseId) next.delete(key);
    }
    return next;
  };
  const next: MonitorAccumulatorState = {
    ...state,
    runtime: { ...state.runtime, entries: remove(state.runtime.entries) },
    semantic: { ...state.semantic, entries: remove(state.semantic.entries) },
    workspace: { ...state.workspace, entries: remove(state.workspace.entries) },
    expiredLeaseIds: new Set(state.expiredLeaseIds).add(input.leaseId),
  };
  return finishAccepted(state, next, input);
}

export function reduceMonitorAccumulator(
  state: MonitorAccumulatorState,
  input: MonitorAccumulatorInput,
): MonitorReduceResult {
  if (input.runtimeRunId !== state.runtimeRunId || input.runtimeEpoch !== state.runtimeEpoch) return rejected(state);
  switch (input.kind) {
    case 'runtime':
      return reduceRuntime(state, input);
    case 'semantic':
      return reduceSemantic(state, input);
    case 'workspace':
      return reduceWorkspace(state, input);
    case 'lease-expired':
      return expireLeases(state, input);
  }
}

function quality(confidence: AgentEventConfidence): EvidenceQuality {
  return confidence === 'authoritative' ? 'exact' : confidence;
}

function completeness(confidence: AgentEventConfidence): EvidenceCompleteness {
  return confidence === 'authoritative' ? 'complete' : 'partial';
}

function actorFor(envelope: AgentEventEnvelope): ActorRunRef | undefined {
  const actorIdentity = envelope.agentId ?? envelope.actorKey;
  if (!actorIdentity) return undefined;
  const rootSessionKey = envelope.nativeSessionId ?? envelope.sessionId;
  return {
    rootSessionKey,
    runKey: envelope.agentId
      ? `${rootSessionKey}:actor:${envelope.agentId}`
      : `${rootSessionKey}:actor-derived:${envelope.actorKey}`,
    role: envelope.actorRole ?? 'child',
    parentRunKey: `${rootSessionKey}:root`,
    ...(envelope.nativeSessionId ? { nativeSessionId: envelope.nativeSessionId } : {}),
    ...(envelope.agentId ? { nativeAgentId: envelope.agentId } : {}),
    ...(envelope.agentType ? { nativeAgentType: envelope.agentType } : {}),
  };
}

function nativeSession(envelope: AgentEventEnvelope, id: string): NativeSessionRef {
  return { namespace: envelope.source, id, basis: 'observed', quality: quality(envelope.confidence) };
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

/**
 * Runtime events share one accumulator owner and scope, so actor-local facts
 * must carry the actor in their source-owned key. Keep root keys readable and
 * encode actor keys as a tuple to avoid delimiter collisions with native IDs.
 */
function actorScopedKey(key: string, actor?: ActorRunRef): string {
  return actor ? JSON.stringify([key, actor.runKey]) : key;
}

/** The public state is lossy by design: a reply is kept only as far as a view can show. */
const MAX_ASSISTANT_MESSAGE_CHARS = 400;

function boundAssistantMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_ASSISTANT_MESSAGE_CHARS ? `${trimmed.slice(0, MAX_ASSISTANT_MESSAGE_CHARS)}…` : trimmed;
}

function unexpectedExit(reason: ProcessExitReason): boolean {
  return reason === 'crash' || reason === 'signal' || reason === 'spawn-failed' || reason === 'workspace-failed';
}

function environmentUpdates(event: EnvironmentUpdatedEvent, actor?: ActorRunRef): MonitorFamilyUpdate[] {
  const updates: MonitorFamilyUpdate[] = [];
  if (event.currentCwd !== undefined || event.git !== undefined) {
    updates.push(
      upsert('environment', actor ? `environment:actor:${actor.runKey}` : 'environment', {
        kind: 'environment',
        ...(actor ? { actor } : {}),
        ...(event.currentCwd !== undefined ? { cwd: event.currentCwd } : {}),
        ...(event.git !== undefined ? { git: event.git } : {}),
      }),
    );
  }
  return updates;
}

function scopedIntentKey(intent: 'configured' | 'observed', actor?: ActorRunRef): string {
  return actor ? `${intent}:actor:${actor.runKey}` : intent;
}

function modelUpdates(event: ModelUpdatedEvent, actor?: ActorRunRef): MonitorFamilyUpdate[] {
  const intent = event.intent ?? 'observed';
  const key = scopedIntentKey(intent, actor);
  if (event.model === null) return [retract('model', key)];
  return [
    upsert('model', key, {
      kind: 'model',
      providerModelId: event.model.id,
      ...(event.model.displayName ? { displayName: event.model.displayName } : {}),
      intent,
      ...(actor ? { actor } : {}),
    }),
  ];
}

function effortUpdates(event: EffortUpdatedEvent, actor?: ActorRunRef): MonitorFamilyUpdate[] {
  const intent = event.intent ?? 'observed';
  const key = scopedIntentKey(intent, actor);
  if (event.effort === null) return [retract('effort', key)];
  return [
    upsert('effort', key, {
      kind: 'effort',
      value: event.effort,
      intent,
      ...(actor ? { actor } : {}),
    }),
  ];
}

function modeUpdates(event: ModeUpdatedEvent, actor?: ActorRunRef): MonitorFamilyUpdate[] {
  const intent = event.intent ?? 'observed';
  const key = `${event.modeKind}:${scopedIntentKey(intent, actor)}`;
  if (event.mode === null) return [retract('mode', key)];
  return [
    upsert('mode', key, {
      kind: 'mode',
      modeKind: event.modeKind,
      raw: event.mode.raw,
      ...(event.mode.normalized ? { normalized: event.mode.normalized } : {}),
      intent,
      ...(actor ? { actor } : {}),
    }),
  ];
}

/** Converts the canonical AgentEvent stream into monitor evidence without mutating detailed Agent state. */
export function translateAgentEventEnvelope(options: TranslateAgentEventOptions): RuntimeMonitorInput {
  const { envelope } = options;
  const eventId = envelope.eventId ?? `legacy:${envelope.sessionId}:${envelope.sequence}`;
  const phase = envelope.replay ? 'bootstrap' : 'live';
  const actor = actorFor(envelope);
  const event = envelope.event;
  const updates: MonitorFamilyUpdate[] = [];

  switch (event.type) {
    case 'process:started':
      if (actor) break;
      updates.push(upsert('status', 'run', { kind: 'run', lifecycle: 'starting', alive: true }));
      break;
    case 'session:started':
      if (actor) break;
      updates.push(
        upsert('status', 'run', {
          kind: 'run',
          lifecycle: 'running',
          alive: true,
          ...(event.nativeSessionId || envelope.nativeSessionId
            ? { nativeSession: nativeSession(envelope, event.nativeSessionId ?? envelope.nativeSessionId!) }
            : {}),
        }),
      );
      break;
    case 'session:ready':
      if (actor) break;
      updates.push(upsert('status', 'run', { kind: 'run', lifecycle: 'running', alive: true }));
      break;
    case 'session:exited':
      if (actor) break;
      updates.push(upsert('status', 'run', { kind: 'run', lifecycle: 'exited', alive: false }));
      break;
    case 'process:exited':
      if (actor) break;
      updates.push(
        upsert('status', 'run', {
          kind: 'run',
          lifecycle: unexpectedExit(event.reason) ? 'failed' : 'exited',
          alive: false,
          ...(unexpectedExit(event.reason)
            ? { failure: { code: event.reason, detail: `Process exited: ${event.reason}`, recoverable: false } }
            : {}),
        }),
      );
      break;
    case 'turn:started':
      updates.push(
        upsert('status', actorScopedKey('turn', actor), {
          kind: 'activity',
          activityKind: 'other',
          active: true,
          line: 'Working',
          since: envelope.timestamp,
          ...(actor ? { actor } : {}),
        }),
        retract('status', actorScopedKey('failure:turn', actor)),
      );
      break;
    case 'turn:completed': {
      updates.push(
        retract('status', actorScopedKey('turn', actor)),
        retract('status', actorScopedKey('responding', actor)),
        retract('status', actorScopedKey('reasoning', actor)),
      );
      const completed =
        event.lastAssistantMessage === undefined ? undefined : boundAssistantMessage(event.lastAssistantMessage);
      if (completed !== undefined) {
        updates.push(
          upsert('conversation', actorScopedKey('message', actor), {
            kind: 'message',
            text: completed,
            final: true,
            ...(actor ? { actor } : {}),
          }),
        );
      }
      break;
    }
    case 'turn:failed':
      updates.push(
        retract('status', actorScopedKey('turn', actor)),
        retract('status', actorScopedKey('responding', actor)),
        retract('status', actorScopedKey('reasoning', actor)),
        upsert('status', actorScopedKey('failure:turn', actor), {
          kind: 'failure',
          failureId: 'turn',
          state: 'active',
          detail: event.error ?? 'Turn failed',
          code: 'turn-failed',
          recoverable: true,
          ...(actor ? { actor } : {}),
        }),
      );
      break;
    case 'conversation:assistant-message': {
      updates.push(
        event.final === false
          ? upsert('status', actorScopedKey('responding', actor), {
              kind: 'activity',
              activityKind: 'responding',
              active: true,
              line: 'Responding',
              since: envelope.timestamp,
              ...(actor ? { actor } : {}),
            })
          : retract('status', actorScopedKey('responding', actor)),
      );
      const text = boundAssistantMessage(event.text);
      if (text !== undefined) {
        updates.push(
          upsert('conversation', actorScopedKey('message', actor), {
            kind: 'message',
            text,
            final: event.final !== false,
            ...(event.messageId ? { messageId: event.messageId } : {}),
            ...(actor ? { actor } : {}),
          }),
        );
      }
      break;
    }
    case 'reasoning:started':
    case 'reasoning:progress':
    case 'reasoning:summary':
      updates.push(
        upsert('status', actorScopedKey('reasoning', actor), {
          kind: 'activity',
          activityKind: 'reasoning',
          active: true,
          line: 'Reasoning',
          since: envelope.timestamp,
          ...(actor ? { actor } : {}),
        }),
      );
      break;
    case 'reasoning:completed':
      updates.push(retract('status', actorScopedKey('reasoning', actor)));
      break;
    case 'tool:requested':
    case 'tool:started':
      updates.push(
        upsert('status', actorScopedKey(`tool:${event.toolCallId}`, actor), {
          kind: 'activity',
          activityKind: 'tool',
          active: true,
          line: event.presentation?.title ?? event.tool ?? 'Using tool',
          since: envelope.timestamp,
          ...(actor ? { actor } : {}),
        }),
      );
      break;
    case 'tool:completed':
    case 'tool:failed':
      updates.push(retract('status', actorScopedKey(`tool:${event.toolCallId}`, actor)));
      break;
    case 'interaction:permission-requested':
      updates.push(
        upsert('status', actorScopedKey(`permission:${event.requestId}`, actor), {
          kind: 'interaction',
          interactionId: event.requestId,
          interactionKind: 'permission',
          state: 'pending',
          permission: { requestId: event.requestId, ...(event.tool ? { tool: event.tool } : {}) },
          ...(actor ? { actor } : {}),
        }),
      );
      break;
    case 'interaction:permission-resolved':
      updates.push(
        upsert('status', actorScopedKey(`permission:${event.requestId}`, actor), {
          kind: 'interaction',
          interactionId: event.requestId,
          interactionKind: 'permission',
          state: 'resolved',
          ...(actor ? { actor } : {}),
        }),
      );
      break;
    case 'interaction:question-requested':
      updates.push(
        upsert('status', actorScopedKey(`question:${event.requestId}`, actor), {
          kind: 'interaction',
          interactionId: event.requestId,
          interactionKind: event.questions.some((question) => question.allowFreeForm)
            ? event.questions.some((question) => (question.options?.length ?? 0) > 0)
              ? 'mixed'
              : 'free-form'
            : event.questions.some((question) => question.allowMultiple)
              ? 'multi-choice'
              : 'choice',
          state: 'pending',
          questions: event.questions,
          ...(actor ? { actor } : {}),
        }),
      );
      break;
    case 'interaction:question-resolved':
      updates.push(
        upsert('status', actorScopedKey(`question:${event.requestId}`, actor), {
          kind: 'interaction',
          interactionId: event.requestId,
          interactionKind: 'mixed',
          state: event.outcome === 'answered' ? 'resolved' : event.outcome,
          ...(actor ? { actor } : {}),
        }),
      );
      break;
    case 'delegation:subagent-started': {
      const child: ActorRunRef = actor ?? {
        rootSessionKey: envelope.nativeSessionId ?? envelope.sessionId,
        runKey: `${envelope.nativeSessionId ?? envelope.sessionId}:actor:${event.subagentId}`,
        role: 'child',
        parentRunKey: `${envelope.nativeSessionId ?? envelope.sessionId}:root`,
        nativeAgentId: event.subagentId,
        ...(event.agentType ? { nativeAgentType: event.agentType } : {}),
      };
      updates.push(upsert('delegation', `actor:${child.runKey}`, { kind: 'actor', actor: child, state: 'active' }));
      break;
    }
    case 'delegation:subagent-stopped': {
      const child: ActorRunRef = actor ?? {
        rootSessionKey: envelope.nativeSessionId ?? envelope.sessionId,
        runKey: `${envelope.nativeSessionId ?? envelope.sessionId}:actor:${event.subagentId}`,
        role: 'child',
        parentRunKey: `${envelope.nativeSessionId ?? envelope.sessionId}:root`,
        nativeAgentId: event.subagentId,
      };
      updates.push(upsert('delegation', `actor:${child.runKey}`, { kind: 'actor', actor: child, state: 'stopped' }));
      break;
    }
    case 'usage:tokens-used':
      if (envelope.replay || !liveUsageOrigin(envelope.source)) break;
      updates.push(
        upsert('usage', event.usageId, {
          kind: 'usage',
          usageId: event.usageId,
          origin: liveUsageOrigin(envelope.source),
          pricing: event.pricing,
          cost: event.cost,
          boundary: event.boundary,
          canonical: event.canonical,
          totalTokens: event.totalTokens,
          meterTokens: event.meterTokens,
          cumulativeTokens: event.cumulativeTokens,
          deltaTokens: event.deltaTokens,
          inputTokens: event.breakdown?.inputTokens,
          freshInputTokens: event.breakdown?.freshInputTokens,
          outputTokens: event.breakdown?.outputTokens,
          cacheReadTokens: event.breakdown?.cacheReadTokens,
          cacheCreationTokens: event.breakdown?.cacheCreationTokens,
          reasoningTokens: event.breakdown?.reasoningTokens,
          costUsd: event.costUsd,
          ...(actor ? { actor } : {}),
        }),
      );
      break;
    case 'context-window:updated': {
      if (
        Number.isFinite(event.usedTokens) &&
        event.usedTokens >= 0 &&
        Number.isFinite(event.capacityTokens) &&
        event.capacityTokens > 0
      ) {
        const validUsedPercentage =
          event.usedPercentage !== undefined &&
          Number.isFinite(event.usedPercentage) &&
          event.usedPercentage >= 0 &&
          event.usedPercentage <= 100;
        updates.push(
          upsert('context', actor ? `actor:${actor.runKey}` : 'root', {
            kind: 'context',
            usedTokens: event.usedTokens,
            capacityTokens: event.capacityTokens,
            usedPercentage: validUsedPercentage
              ? event.usedPercentage
              : Math.min(100, Math.max(0, (event.usedTokens / event.capacityTokens) * 100)),
            percentageSource: validUsedPercentage ? (event.percentageSource ?? 'provider') : 'derived',
            ...(actor ? { actor } : {}),
          }),
        );
      }
      break;
    }
    case 'context-window:invalidated':
      updates.push(retract('context', actor ? `actor:${actor.runKey}` : 'root'));
      break;
    case 'compaction:started':
    case 'compaction:completed':
      updates.push(
        upsert('compaction', actorScopedKey(event.compactionId ?? 'current', actor), {
          kind: 'compaction',
          active: event.type === 'compaction:started',
          trigger: event.trigger,
          ...(event.type === 'compaction:completed' ? { outcome: event.outcome ?? 'completed' } : {}),
          ...(actor ? { actor } : {}),
        }),
      );
      break;
    case 'environment:updated':
      updates.push(...environmentUpdates(event, actor));
      break;
    case 'model:updated':
      updates.push(...modelUpdates(event, actor));
      break;
    case 'effort:updated':
      updates.push(...effortUpdates(event, actor));
      break;
    case 'mode:updated':
      updates.push(...modeUpdates(event, actor));
      break;
    case 'workspace:file-operation':
    case 'workspace:file-changed':
    case 'notification:received':
    case 'adapter:native-event':
      break;
  }

  return {
    kind: 'runtime',
    schemaVersion: 1,
    eventId,
    ...(options.identity ? { identity: options.identity } : {}),
    runtimeRunId: options.runtimeRunId,
    runtimeEpoch: options.runtimeEpoch,
    phase,
    observedAt: envelope.timestamp,
    source: { id: envelope.source, kind: 'agent-event' },
    quality: quality(envelope.confidence),
    completeness: completeness(envelope.confidence),
    provisional: envelope.confidence === 'inferred',
    updates,
    evidence: [{ namespace: 'agent-event', id: eventId }],
  };
}
