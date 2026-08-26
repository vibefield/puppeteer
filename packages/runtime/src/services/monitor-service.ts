import { AdapterMonitorObservationBatchSchema, DEFAULT_MONITOR_FRESHNESS_POLICY } from '@vibecook/puppeteer-core';
import type {
  AgentExecutionMode,
  AgentMonitorHandle,
  AgentMonitorState,
  AgentAdapterSession,
  MonitorArtifactReadResult,
  MonitorNotification,
  NativeSessionRef,
  ObservationLevel,
} from '@vibecook/puppeteer-core';
import {
  createMonitorAccumulatorState,
  DEFAULT_MONITOR_BURN_RATE_WINDOW_MS,
  projectAgentMonitorState,
  reduceMonitorAccumulator,
  translateAgentEventEnvelope,
  type AdapterMonitorObservationBatch,
  type MonitorAccumulatorInput,
  type MonitorAccumulatorState,
  type MonitorFamilyUpdate,
  type RuntimeMonitorInput,
  type RuntimeMonitorObservationBatch,
  type WorkspaceMonitorObservation,
} from '@vibecook/puppeteer-core/monitor-spi';
import type { RuntimeAgentEventEnvelope } from '../types.js';
import type { MonitorClock, MonitorScheduledTask } from '../monitor-clock.js';
import { createMonitorHandle, type MonitorHandleSource, type MonitorHandleSubscriber } from '../monitor-handle.js';
import type { AgentProjectionService } from './projection-service.js';

export const DEFAULT_MONITOR_COALESCE_MS = 100;
export const DEFAULT_MONITOR_ACTIVITY_LEASE_MS = 5_000;
export const DEFAULT_MONITOR_NOTIFICATION_CAPACITY = 256;
export const DEFAULT_MONITOR_ARTIFACT_MAX_BYTES = 256 * 1024;
export const MONITOR_ARTIFACT_HARD_MAX_BYTES = 1024 * 1024;

export interface MonitorArtifactAudit {
  artifactId: string;
  maxBytes: number;
  outcome: 'ok' | 'denied' | 'unavailable' | 'too-large';
  returnedBytes?: number;
  mediaType?: string;
}

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
  onArtifactAudit?: (audit: MonitorArtifactAudit) => void | Promise<void>;
  onError?: (error: Error) => void;
}

/** @deprecated Compatibility name. Prefer `AgentMonitorServiceOptions`. */
export type RuntimeMonitorHubOptions = AgentMonitorServiceOptions;

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

function byteLength(content: string, encoding: 'utf8' | 'base64'): number {
  return Buffer.byteLength(content, encoding);
}

function artifactRefs(state: AgentMonitorState) {
  return state.workflows.flatMap((workflow) => workflow.artifactRefs);
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
  private artifactSession: AgentAdapterSession | undefined;
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

  consume(envelope: RuntimeAgentEventEnvelope, options: { hostProcessEvidence?: boolean } = {}): void {
    if (!this.accepts(envelope)) return;
    if (envelope.event.type === 'monitor:batch') {
      this.acceptSemantic(envelope.event.batch);
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

  attachSession(session: AgentAdapterSession): void {
    if (this.closed || this.frozen) return;
    this.detachSession();
    this.artifactSession = session;
  }

  detachSession(): void {
    this.artifactSession = undefined;
  }

  acceptAgentEvent(envelope: RuntimeAgentEventEnvelope, options: { hostProcessEvidence?: boolean } = {}): boolean {
    const input = translateAgentEventEnvelope({
      runtimeRunId: this.options.runtimeRunId,
      runtimeEpoch: this.options.runtimeEpoch,
      envelope,
    });
    // The host owns process liveness. Adapter/control rails may disappear while
    // the native TUI remains alive, so their terminal-looking events stay on
    // the compatibility stream but cannot remove or fail the monitor.
    if (
      !options.hostProcessEvidence &&
      (envelope.event.type === 'process:exited' || envelope.event.type === 'session:exited')
    ) {
      input.updates = input.updates.filter(
        (update) => !(update.family === 'status' && update.operation === 'upsert' && update.value.kind === 'run'),
      );
    }
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

  async readArtifact(artifactId: string, options: { maxBytes?: number } = {}): Promise<MonitorArtifactReadResult> {
    const requested = options.maxBytes ?? DEFAULT_MONITOR_ARTIFACT_MAX_BYTES;
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      return { status: 'denied', message: 'maxBytes must be positive' };
    }
    if (requested > MONITOR_ARTIFACT_HARD_MAX_BYTES) {
      return {
        status: 'too-large',
        message: 'artifact read exceeds the host limit',
      };
    }

    const projected = projectAgentMonitorState(this.accumulator, {
      previous: this.published,
      asOf: this.options.clock.now().toISOString(),
      burnRateWindowMs: this.burnRateWindowMs,
    });
    const reference = artifactRefs(projected).find((candidate) => candidate.artifactId === artifactId);
    if (!reference) {
      return {
        status: 'unavailable',
        message: 'artifact is not available for this run',
      };
    }
    if (reference.availability !== 'readable' || !this.artifactSession?.readMonitorArtifact) {
      return this.auditedArtifactResult(artifactId, requested, {
        status: 'unavailable',
        artifact: reference,
        message: 'artifact content is unavailable',
      });
    }
    if (reference.byteLength !== undefined && reference.byteLength > requested) {
      return this.auditedArtifactResult(artifactId, requested, { status: 'too-large', artifact: reference });
    }

    let result: MonitorArtifactReadResult;
    try {
      result = await this.artifactSession.readMonitorArtifact(artifactId, { maxBytes: requested });
    } catch (error) {
      this.report(error);
      result = { status: 'unavailable', artifact: reference, message: 'artifact read failed' };
    }
    if (result.status !== 'ok') {
      return this.auditedArtifactResult(artifactId, requested, {
        ...result,
        artifact: result.artifact ?? reference,
      });
    }
    const returnedBytes = byteLength(result.content, result.encoding);
    if (returnedBytes > requested || returnedBytes > MONITOR_ARTIFACT_HARD_MAX_BYTES) {
      return this.auditedArtifactResult(artifactId, requested, { status: 'too-large', artifact: reference });
    }
    const safeResult: MonitorArtifactReadResult = {
      status: 'ok',
      artifact: reference,
      encoding: result.encoding,
      content: result.content,
    };
    return this.auditedArtifactResult(artifactId, requested, safeResult, returnedBytes);
  }

  /** Releases provider/scheduler resources while retaining the final public monitor. */
  freeze(): void {
    if (this.closed || this.frozen) return;
    this.flush();
    this.detachSession();
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
    this.detachSession();
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
    this.scheduleRateBoundary();

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
    const boundaries = [
      ...this.accumulator.runtime.entries.values(),
      ...this.accumulator.semantic.entries.values(),
      ...this.accumulator.workspace.entries.values(),
    ]
      .filter((entry) => entry.value.kind === 'usage' && entry.rateEligible)
      .map((entry) => Date.parse(entry.rateAt ?? entry.effectiveAt ?? entry.observedAt) + this.burnRateWindowMs + 1)
      .filter((boundary) => Number.isFinite(boundary) && boundary > nowMs)
      .sort((left, right) => left - right);
    const nextBoundary = boundaries[0];
    if (nextBoundary === undefined) return;
    this.rateTask = this.options.clock.schedule(nextBoundary - nowMs, () => {
      this.rateTask = undefined;
      this.flush();
      this.scheduleRateBoundary();
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

  private async auditedArtifactResult(
    artifactId: string,
    maxBytes: number,
    result: MonitorArtifactReadResult,
    returnedBytes?: number,
  ): Promise<MonitorArtifactReadResult> {
    const audit: MonitorArtifactAudit = {
      artifactId,
      maxBytes,
      outcome: result.status,
      ...(returnedBytes === undefined ? {} : { returnedBytes }),
      ...(result.artifact?.mediaType ? { mediaType: result.artifact.mediaType } : {}),
    };
    try {
      await this.options.onArtifactAudit?.(audit);
    } catch (error) {
      this.report(error);
    }
    return result;
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(asError(error));
    } catch {
      // Diagnostics are never allowed to become a monitor/process failure.
    }
  }
}

/** @deprecated Compatibility name. Prefer `AgentMonitorService`. */
export { AgentMonitorService as RuntimeMonitorHub };
