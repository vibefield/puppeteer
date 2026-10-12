import { AdapterMonitorObservationBatchSchema, DEFAULT_MONITOR_FRESHNESS_POLICY } from '@vibefield/puppeteer-core';
import type {
  AgentExecutionMode,
  AgentMonitorHandle,
  AgentMonitorState,
  MonitorNotification,
  NativeSessionRef,
  ObservationLevel,
} from '@vibefield/puppeteer-core';
import {
  createMonitorAccumulatorState,
  DEFAULT_MONITOR_BURN_RATE_WINDOW_MS,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
  translateAgentEventEnvelope,
  liveUsageOrigin,
  type AdapterMonitorObservationBatch,
  type MonitorAccumulatorInput,
  type MonitorAccumulatorState,
  type MonitorFamilyUpdate,
  type RuntimeMonitorInput,
  type RuntimeMonitorObservationBatch,
  type WorkspaceMonitorObservation,
} from '@vibefield/puppeteer-core/monitor-spi';
import type { RuntimeAgentEventEnvelope } from '../types.js';
import type { MonitorClock, MonitorScheduledTask } from '../monitor/clock.js';
import { createMonitorHandle, type MonitorHandleSource, type MonitorHandleSubscriber } from '../monitor/handle.js';
import type { AgentProjectionService } from './projection-service.js';
import { priceUsageUpdates } from './usage-pricing.js';

export const DEFAULT_MONITOR_COALESCE_MS = 100;
export const DEFAULT_MONITOR_ACTIVITY_LEASE_MS = 5_000;
export const DEFAULT_MONITOR_NOTIFICATION_CAPACITY = 256;
export interface AgentMonitorServiceOptions {
  runtimeRunId: string;
  runtimeEpoch: number;
  providerId: string;
  executionMode: AgentExecutionMode;
  observationLevel: ObservationLevel;
  allocatedAt: string;
  terminalSessionId?: string;
  clock: MonitorClock;
  coalesceMs?: number;
  activityLeaseMs?: number;
  burnRateWindowMs?: number;
  notificationCapacity?: number;
  onState?: (state: AgentMonitorState) => void;
  onNotification?: (notification: MonitorNotification) => void;
  onError?: (error: Error) => void;
}

type UnscopedWorkspaceMonitorObservation =
  | Omit<Extract<WorkspaceMonitorObservation, { operation: 'upsert' }>, 'runtimeRunId' | 'runtimeEpoch'>
  | Omit<Extract<WorkspaceMonitorObservation, { operation: 'provenance' }>, 'runtimeRunId' | 'runtimeEpoch'>
  | Omit<Extract<WorkspaceMonitorObservation, { operation: 'retract' }>, 'runtimeRunId' | 'runtimeEpoch'>;

function sameBlockers(left: AgentMonitorState, right: AgentMonitorState): boolean {
  return JSON.stringify(left.blockers) === JSON.stringify(right.blockers);
}

function isUrgentTransition(
  previous: AgentMonitorState,
  next: AgentMonitorState,
  input: MonitorAccumulatorInput,
): boolean {
  return (
    previous.alive !== next.alive ||
    !sameBlockers(previous, next) ||
    previous.session.nativeSessionId !== next.session.nativeSessionId ||
    (input.kind === 'semantic' && input.readiness !== undefined)
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function freezeMonitorState(state: AgentMonitorState): AgentMonitorState {
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    for (const nested of Array.isArray(value) ? value : Object.values(value)) freeze(nested);
    Object.freeze(value);
  };
  freeze(state);
  return state;
}

/** One reducer and source subscription shared by every consumer of a runtime run. */
export class AgentMonitorService
  implements MonitorHandleSource, AgentProjectionService<AgentMonitorState, RuntimeAgentEventEnvelope>
{
  readonly name = 'monitor';
  readonly runtimeRunId: string;

  private accumulator: MonitorAccumulatorState;
  private published: AgentMonitorState;
  private readonly subscribers = new Set<MonitorHandleSubscriber>();
  private readonly queuedNotifications: MonitorNotification[] = [];
  private readonly leaseTasks = new Map<string, MonitorScheduledTask>();
  private readonly leaseTokens = new Map<string, number>();
  private leaseTokenSequence = 0;
  private coalesceTask: MonitorScheduledTask | undefined;
  private rateTask: MonitorScheduledTask | undefined;
  private freshnessTask: MonitorScheduledTask | undefined;
  private readonly publishedFreshnessBoundaries = new Set<string>();
  private runtimeInputSequence = 0;
  private started = false;
  private frozen = false;
  private closed = false;

  private readonly coalesceMs: number;
  private readonly activityLeaseMs: number;
  private readonly burnRateWindowMs: number;
  private readonly notificationCapacity: number;

  constructor(private readonly options: AgentMonitorServiceOptions) {
    this.runtimeRunId = options.runtimeRunId;
    this.coalesceMs = options.coalesceMs ?? DEFAULT_MONITOR_COALESCE_MS;
    this.activityLeaseMs = options.activityLeaseMs ?? DEFAULT_MONITOR_ACTIVITY_LEASE_MS;
    this.burnRateWindowMs = options.burnRateWindowMs ?? DEFAULT_MONITOR_BURN_RATE_WINDOW_MS;
    this.notificationCapacity = options.notificationCapacity ?? DEFAULT_MONITOR_NOTIFICATION_CAPACITY;
    if (!Number.isFinite(this.coalesceMs) || this.coalesceMs < 0) {
      throw new RangeError('monitor coalesceMs must be a non-negative finite number');
    }
    if (!Number.isFinite(this.activityLeaseMs) || this.activityLeaseMs <= 0) {
      throw new RangeError('monitor activityLeaseMs must be a positive finite number');
    }
    if (!Number.isFinite(this.burnRateWindowMs) || this.burnRateWindowMs <= 0) {
      throw new RangeError('monitor burnRateWindowMs must be a positive finite number');
    }
    if (!Number.isSafeInteger(this.notificationCapacity) || this.notificationCapacity < 1) {
      throw new RangeError('monitor notificationCapacity must be a positive safe integer');
    }
    this.accumulator = createMonitorAccumulatorState({
      runtimeRunId: options.runtimeRunId,
      runtimeEpoch: options.runtimeEpoch,
      providerId: options.providerId,
      executionMode: options.executionMode,
      observationLevel: options.observationLevel,
      allocatedAt: options.allocatedAt,
      ...(options.terminalSessionId ? { terminalSessionId: options.terminalSessionId } : {}),
    });
    this.published = freezeMonitorState(
      projectAgentMonitorState(this.accumulator, {
        asOf: options.allocatedAt,
        burnRateWindowMs: this.burnRateWindowMs,
      }),
    );
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.publishState(this.published);
    this.scheduleFreshnessBoundary();
  }

  current(): AgentMonitorState {
    return this.published;
  }

  snapshot(): AgentMonitorState {
    return this.current();
  }

  accepts(_envelope: RuntimeAgentEventEnvelope): boolean {
    return !this.closed && !this.frozen;
  }

  consume(envelope: RuntimeAgentEventEnvelope, options: { hostProcessEvidence?: boolean | undefined } = {}): void {
    if (!this.accepts(envelope)) return;
    if (envelope.event.type === 'monitor:batch') {
      const batch = envelope.event.batch;
      this.acceptSemantic(
        envelope.replay || !liveUsageOrigin(envelope.source)
          ? { ...batch, updates: batch.updates.filter((update) => update.family !== 'usage') }
          : batch,
      );
      return;
    }
    this.acceptAgentEvent(envelope, options);
  }

  observe(): AgentMonitorHandle {
    if (this.closed) throw new Error(`monitor is removed: ${this.runtimeRunId}`);
    return createMonitorHandle(this, this.notificationCapacity);
  }

  subscribe(subscriber: MonitorHandleSubscriber): () => void {
    if (this.closed) {
      subscriber.close();
      return () => undefined;
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  updateSessionMetadata(metadata: {
    executionMode: AgentExecutionMode;
    observationLevel: ObservationLevel;
    terminalSessionId: string;
  }): void {
    if (this.closed || this.frozen) return;
    this.accumulator = {
      ...this.accumulator,
      executionMode: metadata.executionMode,
      observationLevel: metadata.observationLevel,
      terminalSessionId: metadata.terminalSessionId,
    };
    this.scheduleFlush();
  }

  acceptAgentEvent(
    envelope: RuntimeAgentEventEnvelope,
    options: { hostProcessEvidence?: boolean | undefined } = {},
  ): boolean {
    const input = translateAgentEventEnvelope({
      runtimeRunId: this.options.runtimeRunId,
      runtimeEpoch: this.options.runtimeEpoch,
      envelope,
    });
    // The host owns process liveness. Adapter/control rails may disappear while
    // the native TUI remains alive, so their terminal-looking events stay on
    // the normalized event stream but cannot remove or fail the monitor.
    if (
      !options.hostProcessEvidence &&
      (envelope.event.type === 'process:exited' || envelope.event.type === 'session:exited')
    ) {
      input.updates = input.updates.filter(
        (update) => !(update.family === 'status' && update.operation === 'upsert' && update.value.kind === 'run'),
      );
    }
    // Transcript metadata remains on the Agent event stream, but carries no
    // monitor evidence. Do not clone/reproject the whole ledger for each row.
    if (input.updates.length === 0) return false;
    return this.accept(input);
  }

  acceptSemantic(batch: AdapterMonitorObservationBatch): boolean {
    if (this.closed || this.frozen) return false;
    const parsed = AdapterMonitorObservationBatchSchema.safeParse(batch);
    if (!parsed.success) {
      this.report(new Error(`Adapter emitted invalid monitor batch: ${parsed.error.message}`));
      return false;
    }
    const input: RuntimeMonitorObservationBatch = {
      ...parsed.data,
      kind: 'semantic',
      runtimeRunId: this.options.runtimeRunId,
      runtimeEpoch: this.options.runtimeEpoch,
    };
    return this.accept(input);
  }

  acceptWorkspace(input: UnscopedWorkspaceMonitorObservation): boolean {
    return this.accept(
      {
        ...input,
        runtimeRunId: this.options.runtimeRunId,
        runtimeEpoch: this.options.runtimeEpoch,
      } as WorkspaceMonitorObservation,
      false,
      input.source.kind === 'workspace-allocation',
    );
  }

  recordPromptReceipt(receiptId: string, observedAt: string): boolean {
    return this.accept({
      kind: 'runtime',
      schemaVersion: 1,
      eventId: `prompt-receipt:${receiptId}`,
      runtimeRunId: this.options.runtimeRunId,
      runtimeEpoch: this.options.runtimeEpoch,
      phase: 'live',
      observedAt,
      source: { id: 'runtime', kind: 'prompt-receipt' },
      quality: 'exact',
      completeness: 'complete',
      provisional: false,
      updates: [],
      evidence: [{ namespace: 'prompt-receipt', id: receiptId }],
    });
  }

  updateRun(
    lifecycle: 'allocated' | 'preparing' | 'starting' | 'running' | 'stopping' | 'exited' | 'failed',
    options: {
      alive: boolean;
      nativeSession?: NativeSessionRef;
      code?: string;
      detail?: string;
      recoverable?: boolean;
    },
  ): boolean {
    const update: MonitorFamilyUpdate = {
      family: 'status',
      operation: 'upsert',
      key: 'run',
      value: {
        kind: 'run',
        lifecycle,
        alive: options.alive,
        ...(options.nativeSession ? { nativeSession: { ...options.nativeSession } } : {}),
        ...(options.code || options.detail
          ? {
              failure: {
                ...(options.code ? { code: options.code } : {}),
                ...(options.detail ? { detail: options.detail } : {}),
                recoverable: options.recoverable ?? false,
              },
            }
          : {}),
      },
    };
    return this.accept(this.runtimeInput(`lifecycle:${lifecycle}`, [update]), true);
  }

  acknowledgeFailure(blockerId: string): boolean {
    const blocker = this.published.blockers.find((candidate) => candidate.id === blockerId);
    if (!blocker || blocker.kind !== 'failure') return false;
    if (this.frozen) {
      const blockers = this.published.blockers.filter((candidate) => candidate.id !== blockerId);
      const status = blockers.length > 0 ? 'blocked' : this.published.activity ? 'working' : 'idle';
      this.published = freezeMonitorState({
        ...this.published,
        revision: this.published.revision + 1,
        status,
        ...(status === this.published.status ? {} : { statusSince: this.options.clock.now().toISOString() }),
        blockers,
      });
      if (this.started) this.publishState(this.published);
      return true;
    }
    const update: MonitorFamilyUpdate =
      blockerId === 'run:runtime'
        ? {
            family: 'status',
            operation: 'upsert',
            key: 'run',
            value: { kind: 'run', lifecycle: 'exited', alive: false },
          }
        : {
            family: 'status',
            operation: 'upsert',
            key: `failure:${blockerId}`,
            value: { kind: 'failure', failureId: blockerId, state: 'dismissed', recoverable: false },
          };
    return this.accept(this.runtimeInput(`failure-acknowledged:${blockerId}`, [update]), true);
  }

  /** Releases provider/scheduler resources while retaining the final public monitor. */
  freeze(): void {
    if (this.closed || this.frozen) return;
    this.flush();
    this.cancelScheduledWork();
    // Retain the bounded public projection, not potentially large private
    // source ledgers, after all process/workspace resources are gone.
    this.accumulator = createMonitorAccumulatorState({
      runtimeRunId: this.options.runtimeRunId,
      runtimeEpoch: this.options.runtimeEpoch,
      providerId: this.options.providerId,
      executionMode: this.published.modes.execution,
      observationLevel: this.published.freshness.level,
      allocatedAt: this.options.allocatedAt,
    });
    this.frozen = true;
  }

  /** Finalizes streams after runtime has synchronously emitted monitor removal. */
  remove(): void {
    if (this.closed) return;
    if (!this.frozen) this.flush();
    this.closed = true;
    this.cancelScheduledWork();
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
  }

  private runtimeInput(name: string, updates: MonitorFamilyUpdate[]): RuntimeMonitorInput {
    const observedAt = this.options.clock.now().toISOString();
    return {
      kind: 'runtime',
      schemaVersion: 1,
      eventId: `runtime-hub:${this.options.runtimeEpoch}:${++this.runtimeInputSequence}:${name}`,
      runtimeRunId: this.options.runtimeRunId,
      runtimeEpoch: this.options.runtimeEpoch,
      phase: 'live',
      observedAt,
      source: { id: 'runtime', kind: 'runtime-lifecycle' },
      quality: 'exact',
      completeness: 'complete',
      provisional: false,
      updates,
      evidence: [],
    };
  }

  private accept(input: MonitorAccumulatorInput, forceUrgent = false, suppressNotifications = false): boolean {
    if (this.closed || this.frozen) return false;
    if (input.kind === 'runtime' || input.kind === 'semantic') {
      input = { ...input, updates: priceUsageUpdates(input.updates, input.phase) };
    }
    let reduced;
    try {
      reduced = reduceMonitorAccumulator(this.accumulator, input);
    } catch (error) {
      this.report(error);
      return false;
    }
    if (!reduced.accepted) return false;
    this.accumulator = reduced.state;
    if (!suppressNotifications) this.queuedNotifications.push(...reduced.notifications);
    this.scheduleLeases(input);

    // Replayed history establishes a baseline. Coalesce the calculation as
    // well as publication; live permission/process transitions stay urgent.
    if (!forceUrgent && input.kind === 'runtime' && input.phase === 'bootstrap') {
      this.scheduleFlush();
      return true;
    }

    const candidate = freezeMonitorState(
      projectAgentMonitorState(this.accumulator, {
        previous: this.published,
        asOf: this.options.clock.now().toISOString(),
        burnRateWindowMs: this.burnRateWindowMs,
      }),
    );
    if (forceUrgent || isUrgentTransition(this.published, candidate, input)) this.flush();
    else this.scheduleFlush();
    return true;
  }

  private scheduleFlush(): void {
    if (this.coalesceTask || this.closed) return;
    this.coalesceTask = this.options.clock.schedule(this.coalesceMs, () => {
      this.coalesceTask = undefined;
      this.flush();
    });
  }

  private flush(scheduleFreshness = true): boolean {
    if (this.closed) return false;
    this.coalesceTask?.cancel();
    this.coalesceTask = undefined;
    const next = freezeMonitorState(
      projectAgentMonitorState(this.accumulator, {
        previous: this.published,
        asOf: this.options.clock.now().toISOString(),
        burnRateWindowMs: this.burnRateWindowMs,
      }),
    );
    const changed = next !== this.published;
    if (changed) {
      this.published = next;
      if (this.started) this.publishState(next);
    }
    if (this.started && this.queuedNotifications.length > 0) {
      const notifications = this.queuedNotifications.splice(0);
      for (const notification of notifications) this.publishNotification(notification);
    }
    this.scheduleRateBoundary();
    if (scheduleFreshness) this.scheduleFreshnessBoundary();
    return changed;
  }

  private publishState(state: AgentMonitorState): void {
    try {
      this.options.onState?.(state);
    } catch (error) {
      this.report(error);
    }
    for (const subscriber of this.subscribers) subscriber.publishState(state);
  }

  private publishNotification(notification: MonitorNotification): void {
    try {
      this.options.onNotification?.(notification);
    } catch (error) {
      this.report(error);
    }
    for (const subscriber of this.subscribers) subscriber.publishNotification(notification);
  }

  private scheduleLeases(input: MonitorAccumulatorInput): void {
    if (input.kind !== 'runtime' && input.kind !== 'semantic') return;
    for (const update of input.updates) {
      if (update.operation !== 'upsert' || update.value.kind !== 'activity' || !update.value.leaseId) continue;
      const leaseId = update.value.leaseId;
      this.leaseTasks.get(leaseId)?.cancel();
      if (!update.value.active) {
        this.leaseTasks.delete(leaseId);
        this.leaseTokens.delete(leaseId);
        continue;
      }
      const token = ++this.leaseTokenSequence;
      this.leaseTokens.set(leaseId, token);
      this.leaseTasks.set(
        leaseId,
        this.options.clock.schedule(this.activityLeaseMs, () => {
          if (this.leaseTokens.get(leaseId) !== token) return;
          this.leaseTokens.delete(leaseId);
          this.leaseTasks.delete(leaseId);
          this.accept(
            {
              kind: 'lease-expired',
              runtimeRunId: this.options.runtimeRunId,
              runtimeEpoch: this.options.runtimeEpoch,
              leaseId,
              expiredAt: this.options.clock.now().toISOString(),
            },
            true,
          );
        }),
      );
    }
  }

  private scheduleRateBoundary(): void {
    this.rateTask?.cancel();
    this.rateTask = undefined;
    const nowMs = this.options.clock.now().getTime();
    let nextBoundary = Infinity;
    for (const entries of [
      this.accumulator.runtime.entries,
      this.accumulator.semantic.entries,
      this.accumulator.workspace.entries,
    ]) {
      for (const entry of entries.values()) {
        if (entry.value.kind !== 'usage' || !entry.rateEligible) continue;
        const boundary = Date.parse(entry.rateAt ?? entry.effectiveAt ?? entry.observedAt) + this.burnRateWindowMs + 1;
        if (boundary > nowMs && boundary < nextBoundary) nextBoundary = boundary;
      }
    }
    if (!Number.isFinite(nextBoundary)) return;
    this.rateTask = this.options.clock.schedule(nextBoundary - nowMs, () => {
      this.rateTask = undefined;
      this.flush();
    });
  }

  private scheduleFreshnessBoundary(): void {
    this.freshnessTask?.cancel();
    this.freshnessTask = undefined;
    if (this.closed) return;
    const nowMs = this.options.clock.now().getTime();
    const currentBoundaries = Object.entries(this.published.freshness.families).flatMap(([family, freshness]) => {
      if (!freshness?.asOf || freshness.support === 'unsupported') return [];
      const at = Date.parse(freshness.asOf) + DEFAULT_MONITOR_FRESHNESS_POLICY.staleAfterMs + 1;
      return Number.isFinite(at) ? [{ key: `${family}\0${freshness.asOf}`, at }] : [];
    });
    const currentKeys = new Set(currentBoundaries.map(({ key }) => key));
    for (const key of this.publishedFreshnessBoundaries) {
      if (!currentKeys.has(key)) this.publishedFreshnessBoundaries.delete(key);
    }
    const boundaries = currentBoundaries.filter((boundary) => !this.publishedFreshnessBoundaries.has(boundary.key));
    for (const boundary of boundaries) {
      // A newly installed historical snapshot is already rendered with its
      // current recency; only future fresh -> stale crossings need a pulse.
      if (boundary.at <= nowMs) this.publishedFreshnessBoundaries.add(boundary.key);
    }
    const next = boundaries.filter((boundary) => boundary.at > nowMs).sort((left, right) => left.at - right.at)[0];
    if (!next) return;
    this.freshnessTask = this.options.clock.schedule(next.at - nowMs, () => {
      this.freshnessTask = undefined;
      this.flush(false);
      const crossedAt = this.options.clock.now().getTime();
      const crossed = Object.entries(this.published.freshness.families)
        .flatMap(([family, freshness]) => {
          if (!freshness?.asOf || freshness.support === 'unsupported') return [];
          const at = Date.parse(freshness.asOf) + DEFAULT_MONITOR_FRESHNESS_POLICY.staleAfterMs + 1;
          return Number.isFinite(at) ? [{ key: `${family}\0${freshness.asOf}`, at }] : [];
        })
        .filter((boundary) => boundary.at <= crossedAt && !this.publishedFreshnessBoundaries.has(boundary.key));
      for (const boundary of crossed) this.publishedFreshnessBoundaries.add(boundary.key);
      if (crossed.length > 0) {
        this.published = freezeMonitorState({ ...this.published, revision: this.published.revision + 1 });
        if (this.started) this.publishState(this.published);
      }
      this.scheduleFreshnessBoundary();
    });
  }

  private cancelScheduledWork(): void {
    this.coalesceTask?.cancel();
    this.coalesceTask = undefined;
    this.rateTask?.cancel();
    this.rateTask = undefined;
    this.freshnessTask?.cancel();
    this.freshnessTask = undefined;
    for (const task of this.leaseTasks.values()) task.cancel();
    this.leaseTasks.clear();
    this.leaseTokens.clear();
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(asError(error));
    } catch {
      // Diagnostics are never allowed to become a monitor/process failure.
    }
  }
}
