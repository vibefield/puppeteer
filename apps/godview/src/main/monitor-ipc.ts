import {
  isMonitorStateAfterRemoval,
  isNewerMonitorRevision,
  type AgentMonitorHandle,
  type AgentMonitorState,
  type MonitorNotification,
} from '@vibecook/puppeteer-core';

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

export interface MonitorIpcRelayOptions {
  onState?: (message: AgentMonitorStateMessage) => void;
  onNotification?: (message: AgentMonitorNotificationMessage) => void;
  onRemoved?: (message: AgentMonitorRemovedMessage) => void;
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
 * Main-process source of truth for monitor delivery. It orders full replacements,
 * retains only reconnect state, and intentionally never retains notifications.
 */
export class MonitorIpcRelay {
  private readonly states = new Map<string, AgentMonitorState>();
  private readonly terminalByRun = new Map<string, string>();
  private readonly runByTerminal = new Map<string, string>();
  private readonly tombstones = new Map<string, MonitorTombstone>();
  private readonly tombstoneOrder: Array<{ runtimeRunId: string; tombstone: MonitorTombstone }> = [];
  private readonly notificationIds = new Set<string>();
  private readonly notificationOrder: string[] = [];

  constructor(private readonly options: MonitorIpcRelayOptions = {}) {}

  bindTerminal(runtimeRunId: string, terminalSessionId: string): boolean {
    if (!isOpaqueMonitorIdentifier(runtimeRunId) || !terminalSessionId) return false;
    const previousTerminal = this.terminalByRun.get(runtimeRunId);
    if (previousTerminal === terminalSessionId) return true;
    if (previousTerminal) this.runByTerminal.delete(previousTerminal);
    const previousRun = this.runByTerminal.get(terminalSessionId);
    if (previousRun && previousRun !== runtimeRunId) this.terminalByRun.delete(previousRun);
    this.terminalByRun.set(runtimeRunId, terminalSessionId);
    this.runByTerminal.set(terminalSessionId, runtimeRunId);
    return true;
  }

  acceptState(state: AgentMonitorState): boolean {
    if (!isOpaqueMonitorIdentifier(state.runtimeRunId)) return false;
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
    return true;
  }

  acceptNotification(notification: MonitorNotification): boolean {
    if (!isOpaqueMonitorIdentifier(notification.runtimeRunId)) return false;
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

  remove(runtimeRunId: string): boolean {
    if (this.tombstones.has(runtimeRunId)) return false;
    const state = this.states.get(runtimeRunId);
    const terminalSessionId = this.terminalByRun.get(runtimeRunId);
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
    }
    return true;
  }

  snapshot(): AgentMonitorStateMessage[] {
    return [...this.states.values()]
      .sort((left, right) => left.runtimeRunId.localeCompare(right.runtimeRunId))
      .map((state) => this.stateMessage(state));
  }

  hasRun(runtimeRunId: string): boolean {
    return this.states.has(runtimeRunId);
  }

  private stateMessage(state: AgentMonitorState): AgentMonitorStateMessage {
    return {
      runtimeRunId: state.runtimeRunId,
      terminalSessionId: this.terminalByRun.get(state.runtimeRunId) ?? null,
      state,
    };
  }
}

export interface MonitorIpcRuntimeSource {
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
    if (closed) return false;
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
