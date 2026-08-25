import {
  isMonitorStateAfterRemoval,
  isNewerMonitorRevision,
  type AgentMonitorHandle,
  type AgentMonitorState,
  type MonitorArtifactReadResult,
  type MonitorNotification,
  type SessionRuntimeState,
} from '@vibecook/chopsticks-core';
import { DEFAULT_MONITOR_COALESCE_MS, MONITOR_ARTIFACT_HARD_MAX_BYTES } from './monitor-hub.js';
import { compareLegacyAndMonitorState, type MonitorShadowMismatch } from './monitor-shadow.js';

export interface AgentMonitorStateMessage {
  runtimeRunId: string;
  terminalSessionId: string | null;
  state: AgentMonitorState;
}

export interface AgentMonitorNotificationMessage {
  runtimeRunId: string;
  terminalSessionId: string | null;
  notification: MonitorNotification;
}

export interface AgentMonitorRemovedMessage {
  runtimeRunId: string;
  terminalSessionId: string | null;
  /** Last sealed monitor revision, or null when removal preceded first publication. */
  runtimeEpoch: number | null;
  revision: number | null;
}

export interface AcknowledgeAgentFailureRequest {
  runtimeRunId: string;
  blockerId: string;
}

export interface ReadAgentMonitorArtifactRequest {
  runtimeRunId: string;
  artifactId: string;
  maxBytes: number;
}

export interface MonitorShadowMismatchReport {
  runtimeRunId: string;
  runtimeEpoch: number;
  revision: number;
  terminalSessionId: string;
  mismatches: MonitorShadowMismatch[];
}

export interface MonitorHostFeatureFlags {
  monitorV2: boolean;
  shadowComparison: boolean;
  /** Coordinated Godview + Workbench renderer cutover; false is the rollback path. */
  godviewMonitorV2: boolean;
  /** Explicit canary-only JSONL trace of the public monitor revision stream. */
  canaryTrace: boolean;
}

export interface AgentMonitorRendererConfiguration {
  godviewMonitorV2: boolean;
}

/** Shared renderer ordering rule for full replacement messages. */
export function isNewerAgentMonitorStateMessage(
  current: AgentMonitorStateMessage | undefined,
  candidate: AgentMonitorStateMessage,
): boolean {
  return current === undefined || isNewerMonitorRevision(candidate.state, current.state);
}

/** A removal seals its epoch; only explicit reconstruction at a newer epoch may revive a run. */
export function isAgentMonitorStateAfterRemoval(
  candidate: AgentMonitorStateMessage,
  removal: AgentMonitorRemovedMessage,
): boolean {
  return isMonitorStateAfterRemoval(candidate.state, removal.runtimeEpoch);
}

/** One typed command-line boundary shared by both Electron hosts. */
export function resolveMonitorHostFeatureFlags(argv: readonly string[]): MonitorHostFeatureFlags {
  const shadowComparison = argv.includes('--chopsticks-monitor-shadow');
  const godviewMonitorV2 = argv.includes('--chopsticks-godview-monitor-v2');
  const canaryTrace = argv.includes('--chopsticks-monitor-canary-trace');
  return {
    monitorV2: shadowComparison || godviewMonitorV2 || canaryTrace || argv.includes('--chopsticks-monitor-v2'),
    shadowComparison,
    godviewMonitorV2,
    canaryTrace,
  };
}

export const MONITOR_CANARY_TRACE_PREFIX = '[monitor-canary] ';

export interface MonitorCanaryTracePayloads {
  state: AgentMonitorStateMessage;
  notification: AgentMonitorNotificationMessage;
  removed: AgentMonitorRemovedMessage;
  'shadow-mismatch': MonitorShadowMismatchReport;
}

export type MonitorCanaryTraceKind = keyof MonitorCanaryTracePayloads;

export interface MonitorCanaryTraceRecord<K extends MonitorCanaryTraceKind = MonitorCanaryTraceKind> {
  schemaVersion: 1;
  kind: K;
  observedAt: string;
  runtimeRunId: string;
  terminalSessionId: string | null;
  payload: MonitorCanaryTracePayloads[K];
}

/**
 * Serializes one explicit canary observation as a single prefixed JSONL line.
 *
 * Payloads are renderer-safe public monitor contracts, never private evidence,
 * artifact bodies, transcript paths, or hook secrets. They may still contain
 * user-visible prompts, task labels, and cwd, so this is opt-in and callers
 * must treat redirected output as sensitive operational data.
 */
export function formatMonitorCanaryTrace<K extends MonitorCanaryTraceKind>(
  kind: K,
  payload: MonitorCanaryTracePayloads[K],
  observedAt = new Date().toISOString(),
): string {
  const record: MonitorCanaryTraceRecord<K> = {
    schemaVersion: 1,
    kind,
    observedAt,
    runtimeRunId: payload.runtimeRunId,
    terminalSessionId: payload.terminalSessionId,
    payload,
  };
  return `${MONITOR_CANARY_TRACE_PREFIX}${JSON.stringify(record)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Renderer-supplied identities must be opaque labels, never filesystem paths. */
export function isOpaqueMonitorIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.toLowerCase().startsWith('file:') &&
    !/^[a-zA-Z]:/.test(value)
  );
}

export function parseAcknowledgeAgentFailureRequest(value: unknown): AcknowledgeAgentFailureRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (!isOpaqueMonitorIdentifier(value.runtimeRunId) || !isOpaqueMonitorIdentifier(value.blockerId)) return undefined;
  return { runtimeRunId: value.runtimeRunId, blockerId: value.blockerId };
}

export type ReadAgentMonitorArtifactValidation =
  { ok: true; request: ReadAgentMonitorArtifactRequest } | { ok: false; result: MonitorArtifactReadResult };

export function validateReadAgentMonitorArtifactRequest(value: unknown): ReadAgentMonitorArtifactValidation {
  if (!isRecord(value)) return { ok: false, result: { status: 'denied' } };
  if (!isOpaqueMonitorIdentifier(value.runtimeRunId) || !isOpaqueMonitorIdentifier(value.artifactId)) {
    return { ok: false, result: { status: 'denied' } };
  }
  if (!Number.isSafeInteger(value.maxBytes) || (value.maxBytes as number) <= 0) {
    return { ok: false, result: { status: 'denied' } };
  }
  if ((value.maxBytes as number) > MONITOR_ARTIFACT_HARD_MAX_BYTES) {
    return { ok: false, result: { status: 'too-large' } };
  }
  return {
    ok: true,
    request: {
      runtimeRunId: value.runtimeRunId,
      artifactId: value.artifactId,
      maxBytes: value.maxBytes as number,
    },
  };
}

function publicArtifact(result: MonitorArtifactReadResult['artifact']): MonitorArtifactReadResult['artifact'] {
  if (!result) return undefined;
  return {
    artifactId: result.artifactId,
    family: result.family,
    ...(result.mediaType === undefined ? {} : { mediaType: result.mediaType }),
    ...(result.byteLength === undefined ? {} : { byteLength: result.byteLength }),
    ...(result.contentHash === undefined ? {} : { contentHash: result.contentHash }),
    availability: result.availability,
  };
}

/** Removes provider-authored error text before it crosses the renderer trust boundary. */
export function sanitizeMonitorArtifactReadResult(result: MonitorArtifactReadResult): MonitorArtifactReadResult {
  const artifact = publicArtifact(result.artifact);
  if (result.status === 'ok') {
    return {
      status: 'ok',
      artifact: artifact!,
      encoding: result.encoding,
      content: result.content,
    };
  }
  return { status: result.status, ...(artifact === undefined ? {} : { artifact }) };
}

export interface MonitorIpcRuntimeActions {
  acknowledgeFailureBlocker(runtimeRunId: string, blockerId: string): Promise<boolean>;
  readMonitorArtifact(
    runtimeRunId: string,
    artifactId: string,
    options: { maxBytes: number },
  ): Promise<MonitorArtifactReadResult>;
}

export interface MonitorIpcRunLookup {
  hasRun(runtimeRunId: string): boolean;
}

export function acknowledgeAgentFailureForIpc(
  runtime: MonitorIpcRuntimeActions,
  runs: MonitorIpcRunLookup,
  input: unknown,
): Promise<boolean> {
  const request = parseAcknowledgeAgentFailureRequest(input);
  if (!request || !runs.hasRun(request.runtimeRunId)) return Promise.resolve(false);
  // The runtime accepts only retained, dead failure blockers. Permission and
  // question blockers cannot be dismissed through this operation.
  return runtime.acknowledgeFailureBlocker(request.runtimeRunId, request.blockerId);
}

export async function readAgentMonitorArtifactForIpc(
  runtime: MonitorIpcRuntimeActions,
  runs: MonitorIpcRunLookup,
  input: unknown,
): Promise<MonitorArtifactReadResult> {
  const validation = validateReadAgentMonitorArtifactRequest(input);
  if (!validation.ok) return validation.result;
  if (!runs.hasRun(validation.request.runtimeRunId)) return { status: 'unavailable' };
  const result = await runtime.readMonitorArtifact(validation.request.runtimeRunId, validation.request.artifactId, {
    maxBytes: validation.request.maxBytes,
  });
  return sanitizeMonitorArtifactReadResult(result);
}

export interface MonitorIpcRelayOptions {
  enabled: boolean;
  shadowComparison?: boolean;
  onState?: (message: AgentMonitorStateMessage) => void;
  onNotification?: (message: AgentMonitorNotificationMessage) => void;
  onRemoved?: (message: AgentMonitorRemovedMessage) => void;
  onShadowMismatch?: (report: MonitorShadowMismatchReport) => void;
  scheduleComparison?: (callback: () => void) => void;
}

interface MonitorRevision {
  runtimeEpoch: number;
  revision: number;
}

interface MonitorTombstone {
  revision?: MonitorRevision;
}

const MAX_MONITOR_IPC_TOMBSTONES = 2048;

function isNewer(state: AgentMonitorState, previous: MonitorRevision): boolean {
  return isNewerMonitorRevision(state, previous);
}

/**
 * Main-process source of truth for v2 delivery. It orders full replacements,
 * retains only reconnect state, and intentionally never retains notifications.
 */
export class MonitorIpcRelay {
  private readonly states = new Map<string, AgentMonitorState>();
  private readonly terminalByRun = new Map<string, string>();
  private readonly runByTerminal = new Map<string, string>();
  private readonly legacyByTerminal = new Map<string, SessionRuntimeState>();
  private readonly tombstones = new Map<string, MonitorTombstone>();
  private readonly tombstoneOrder: Array<{ runtimeRunId: string; tombstone: MonitorTombstone }> = [];
  private readonly notificationIds = new Set<string>();
  private readonly notificationOrder: string[] = [];
  private readonly comparisonGenerations = new Map<string, number>();
  private readonly mismatchSignatures = new Map<string, string>();
  private readonly latestMismatchReports = new Map<string, MonitorShadowMismatchReport>();
  private readonly schedule: (callback: () => void) => void;

  constructor(private readonly options: MonitorIpcRelayOptions) {
    this.schedule =
      options.scheduleComparison ??
      ((callback) => {
        // Runtime publishes ordinary v2 revisions on this coalescing boundary.
        // Use a trailing settle window longer than one coalescing interval: a
        // v1 native event and the matching v2 projection can land on opposite
        // sides of the first timer boundary.
        const task = setTimeout(callback, DEFAULT_MONITOR_COALESCE_MS * 3);
        task.unref?.();
      });
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  bindTerminal(runtimeRunId: string, terminalSessionId: string): boolean {
    if (!this.options.enabled || !isOpaqueMonitorIdentifier(runtimeRunId) || !terminalSessionId) return false;
    const previousTerminal = this.terminalByRun.get(runtimeRunId);
    if (previousTerminal === terminalSessionId) return true;
    if (previousTerminal) this.runByTerminal.delete(previousTerminal);
    const previousRun = this.runByTerminal.get(terminalSessionId);
    if (previousRun && previousRun !== runtimeRunId) this.terminalByRun.delete(previousRun);
    this.terminalByRun.set(runtimeRunId, terminalSessionId);
    this.runByTerminal.set(terminalSessionId, runtimeRunId);
    this.scheduleShadowComparison(runtimeRunId);
    return true;
  }

  acceptState(state: AgentMonitorState): boolean {
    if (!this.options.enabled || !isOpaqueMonitorIdentifier(state.runtimeRunId)) return false;
    const previous = this.states.get(state.runtimeRunId);
    if (previous && !isNewer(state, previous)) return false;
    if (this.tombstones.has(state.runtimeRunId)) {
      const tombstone = this.tombstones.get(state.runtimeRunId);
      // Removal seals a whole runtime epoch, not merely the last revision seen
      // by the host. Only explicit reconstruction at a newer epoch may revive
      // the same durable run identity.
      if (!tombstone?.revision || state.runtimeEpoch <= tombstone.revision.runtimeEpoch) return false;
    }
    this.tombstones.delete(state.runtimeRunId);
    this.states.set(state.runtimeRunId, state);
    this.options.onState?.(this.stateMessage(state));
    this.scheduleShadowComparison(state.runtimeRunId);
    return true;
  }

  acceptNotification(notification: MonitorNotification): boolean {
    if (!this.options.enabled || !isOpaqueMonitorIdentifier(notification.runtimeRunId)) return false;
    if (this.tombstones.has(notification.runtimeRunId) && !this.states.has(notification.runtimeRunId)) return false;
    const key = `${notification.runtimeRunId}\0${notification.notificationId}`;
    if (this.notificationIds.has(key)) return false;
    this.notificationIds.add(key);
    this.notificationOrder.push(key);
    while (this.notificationOrder.length > 1024) {
      const oldest = this.notificationOrder.shift();
      if (oldest) this.notificationIds.delete(oldest);
    }
    this.options.onNotification?.({
      runtimeRunId: notification.runtimeRunId,
      terminalSessionId: this.terminalByRun.get(notification.runtimeRunId) ?? null,
      notification,
    });
    return true;
  }

  acceptLegacyState(terminalSessionId: string, state: SessionRuntimeState): void {
    if (!this.options.enabled || !this.options.shadowComparison) return;
    this.legacyByTerminal.set(terminalSessionId, state);
    const runtimeRunId = this.runByTerminal.get(terminalSessionId);
    if (runtimeRunId) this.scheduleShadowComparison(runtimeRunId);
  }

  remove(runtimeRunId: string): boolean {
    if (!this.options.enabled || this.tombstones.has(runtimeRunId)) return false;
    const state = this.states.get(runtimeRunId);
    const terminalSessionId = this.terminalByRun.get(runtimeRunId);
    // Transition skew is no longer legitimate at removal. Compare once before
    // deleting either side so an actually stale final v2 state remains visible.
    this.compareShadow(runtimeRunId, true);
    this.options.onRemoved?.({
      runtimeRunId,
      terminalSessionId: terminalSessionId ?? null,
      runtimeEpoch: state?.runtimeEpoch ?? null,
      revision: state?.revision ?? null,
    });
    const tombstone: MonitorTombstone = {
      ...(state ? { revision: { runtimeEpoch: state.runtimeEpoch, revision: state.revision } } : {}),
    };
    this.tombstones.set(runtimeRunId, tombstone);
    this.tombstoneOrder.push({ runtimeRunId, tombstone });
    while (this.tombstoneOrder.length > MAX_MONITOR_IPC_TOMBSTONES) {
      const oldest = this.tombstoneOrder.shift();
      if (oldest && this.tombstones.get(oldest.runtimeRunId) === oldest.tombstone) {
        this.tombstones.delete(oldest.runtimeRunId);
      }
    }
    this.states.delete(runtimeRunId);
    this.terminalByRun.delete(runtimeRunId);
    if (terminalSessionId) {
      this.runByTerminal.delete(terminalSessionId);
      this.legacyByTerminal.delete(terminalSessionId);
    }
    this.mismatchSignatures.delete(runtimeRunId);
    this.latestMismatchReports.delete(runtimeRunId);
    this.comparisonGenerations.delete(runtimeRunId);
    return true;
  }

  snapshot(): AgentMonitorStateMessage[] {
    if (!this.options.enabled) return [];
    return [...this.states.values()]
      .sort((left, right) => left.runtimeRunId.localeCompare(right.runtimeRunId))
      .map((state) => this.stateMessage(state));
  }

  hasRun(runtimeRunId: string): boolean {
    return this.states.has(runtimeRunId);
  }

  shadowMismatches(): MonitorShadowMismatchReport[] {
    return [...this.latestMismatchReports.values()];
  }

  private stateMessage(state: AgentMonitorState): AgentMonitorStateMessage {
    return {
      runtimeRunId: state.runtimeRunId,
      terminalSessionId: this.terminalByRun.get(state.runtimeRunId) ?? null,
      state,
    };
  }

  private scheduleShadowComparison(runtimeRunId: string): void {
    if (!this.options.shadowComparison) return;
    const generation = (this.comparisonGenerations.get(runtimeRunId) ?? 0) + 1;
    this.comparisonGenerations.set(runtimeRunId, generation);
    this.schedule(() => {
      if (this.comparisonGenerations.get(runtimeRunId) !== generation) return;
      this.comparisonGenerations.delete(runtimeRunId);
      this.compareShadow(runtimeRunId);
    });
  }

  private compareShadow(runtimeRunId: string, final = false): void {
    const monitor = this.states.get(runtimeRunId);
    const terminalSessionId = this.terminalByRun.get(runtimeRunId);
    const legacy = terminalSessionId ? this.legacyByTerminal.get(terminalSessionId) : undefined;
    if (!monitor || !terminalSessionId || !legacy) return;
    const mismatches = compareLegacyAndMonitorState(legacy, monitor, { final });
    const signature = JSON.stringify(mismatches);
    if (this.mismatchSignatures.get(runtimeRunId) === signature) return;
    this.mismatchSignatures.set(runtimeRunId, signature);
    if (mismatches.length === 0) {
      this.latestMismatchReports.delete(runtimeRunId);
      return;
    }
    const report: MonitorShadowMismatchReport = {
      runtimeRunId,
      runtimeEpoch: monitor.runtimeEpoch,
      revision: monitor.revision,
      terminalSessionId,
      mismatches,
    };
    this.latestMismatchReports.set(runtimeRunId, report);
    this.options.onShadowMismatch?.(report);
  }
}

export interface MonitorIpcRuntimeSource extends MonitorIpcRuntimeActions {
  runtimeRunInfo(runtimeRunId: string):
    | {
        status: 'allocated' | 'preparing' | 'prepared' | 'active' | 'terminal';
        terminalSessionId?: string;
      }
    | undefined;
  observeMonitor(runtimeRunId: string): AgentMonitorHandle;
  onMonitorState(listener: (state: AgentMonitorState) => void): () => void;
  onMonitorNotification(listener: (notification: MonitorNotification) => void): () => void;
  onMonitorRemoved(listener: (runtimeRunId: string) => void): () => void;
}

export interface MonitorIpcConnection {
  /** Ensures the race-free handle exists before a host installs any snapshot. */
  start(runtimeRunId: string): boolean;
  close(): Promise<void>;
}

/**
 * Connects runtime discovery callbacks to per-run race-free handles. Global
 * callbacks discover a newly allocated run; all installed state and notices
 * are then drained from the handle subscribed during that callback.
 */
export function connectMonitorIpcRelay(
  runtime: MonitorIpcRuntimeSource,
  relay: MonitorIpcRelay,
  onError: (error: Error) => void = () => undefined,
): MonitorIpcConnection {
  const handles = new Map<string, AgentMonitorHandle>();
  let closed = false;

  const report = (error: unknown): void => onError(error instanceof Error ? error : new Error(String(error)));

  const installState = (state: AgentMonitorState): boolean => {
    const run = runtime.runtimeRunInfo(state.runtimeRunId);
    if (!run) return false;
    if (run.terminalSessionId) relay.bindTerminal(state.runtimeRunId, run.terminalSessionId);
    // Do not publish a provisional null routing key for a run that can still
    // acquire a terminal. A terminal creation failure is permanently unbound
    // and is therefore intentionally represented with null.
    if (!run.terminalSessionId && run.status !== 'terminal') return false;
    return relay.acceptState(state);
  };

  const installNotification = (notification: MonitorNotification): boolean => {
    const run = runtime.runtimeRunInfo(notification.runtimeRunId);
    if (!run) return false;
    if (run.terminalSessionId) relay.bindTerminal(notification.runtimeRunId, run.terminalSessionId);
    if (!run.terminalSessionId && run.status !== 'terminal') return false;
    return relay.acceptNotification(notification);
  };

  const drainStates = async (handle: AgentMonitorHandle): Promise<void> => {
    try {
      for await (const state of handle.states) installState(state);
    } catch (error) {
      if (!closed) report(error);
    }
  };

  const drainNotifications = async (handle: AgentMonitorHandle): Promise<void> => {
    try {
      for await (const notification of handle.notifications) installNotification(notification);
    } catch (error) {
      if (!closed) report(error);
    }
  };

  const start = (runtimeRunId: string): boolean => {
    if (closed || !relay.enabled) return false;
    if (handles.has(runtimeRunId)) return true;
    try {
      // observeMonitor itself subscribes before reading its initial snapshot.
      const handle = runtime.observeMonitor(runtimeRunId);
      handles.set(runtimeRunId, handle);
      void drainStates(handle);
      void drainNotifications(handle);
      void handle.ready.then(installState).catch(report);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  };

  const unsubscribeState = runtime.onMonitorState((state) => {
    start(state.runtimeRunId);
  });
  const unsubscribeNotification = runtime.onMonitorNotification((notification) => {
    start(notification.runtimeRunId);
  });
  const unsubscribeRemoved = runtime.onMonitorRemoved((runtimeRunId) => {
    relay.remove(runtimeRunId);
    const handle = handles.get(runtimeRunId);
    handles.delete(runtimeRunId);
    if (handle) void handle.close().catch(report);
  });

  return {
    start,
    async close() {
      if (closed) return;
      closed = true;
      unsubscribeState();
      unsubscribeNotification();
      unsubscribeRemoved();
      const activeHandles = [...handles.values()];
      handles.clear();
      await Promise.all(activeHandles.map((handle) => handle.close().catch(report)));
    },
  };
}
