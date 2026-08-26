import {
  isMonitorStateAfterRemoval,
  isNewerMonitorRevision,
  type AgentMonitorState,
  type MonitorNotification,
} from '@vibecook/puppeteer-core';

export interface AgentMonitorRemoval {
  runtimeRunId: string;
  /** A null epoch seals the identity permanently because later ordering cannot be proven. */
  runtimeEpoch: number | null;
}

export interface AgentMonitorStoreSnapshot {
  readonly states: readonly AgentMonitorState[];
  readonly notifications: readonly MonitorNotification[];
}

export interface AgentMonitorStore {
  getSnapshot(): AgentMonitorStoreSnapshot;
  getState(runtimeRunId: string): AgentMonitorState | undefined;
  subscribe(listener: () => void): () => void;
  acceptState(state: AgentMonitorState): boolean;
  acceptStates(states: readonly AgentMonitorState[]): number;
  remove(removal: AgentMonitorRemoval): boolean;
  acceptNotification(notification: MonitorNotification): boolean;
  dismissNotification(runtimeRunId: string, notificationId: string): boolean;
  clear(): void;
}

export interface CreateAgentMonitorStoreOptions {
  /** Number of recent, undismissed notifications retained for a view. Default: 4. */
  notificationCapacity?: number;
  onListenerError?: (error: unknown) => void;
}

const EMPTY_SNAPSHOT: AgentMonitorStoreSnapshot = Object.freeze({
  states: Object.freeze([]),
  notifications: Object.freeze([]),
});

/** Monitor state is JSON-plain; taking it into the store also makes it immutable. */
function freezeTree<T>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    for (const nested of Array.isArray(candidate) ? candidate : Object.values(candidate)) freeze(nested);
    Object.freeze(candidate);
  };
  freeze(value);
  return value;
}

/**
 * Framework- and transport-neutral monitor state.
 *
 * Full snapshots obey runtime epoch/revision ordering, removals seal an epoch,
 * and notifications are bounded and deduplicated. `getSnapshot()` is referentially
 * stable until one of those public collections actually changes.
 */
export function createAgentMonitorStore(options: CreateAgentMonitorStoreOptions = {}): AgentMonitorStore {
  const notificationCapacity = options.notificationCapacity ?? 4;
  if (!Number.isSafeInteger(notificationCapacity) || notificationCapacity < 1) {
    throw new RangeError('notificationCapacity must be a positive safe integer');
  }

  const statesByRunId = new Map<string, AgentMonitorState>();
  const sealedEpochs = new Map<string, number | null>();
  const listeners = new Set<() => void>();
  let notifications: MonitorNotification[] = [];
  let snapshot = EMPTY_SNAPSHOT;

  const publish = (): void => {
    snapshot = Object.freeze({
      states: Object.freeze([...statesByRunId.values()]),
      notifications: Object.freeze([...notifications]),
    });
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        try {
          options.onListenerError?.(error);
        } catch {
          // A diagnostic hook is still a listener; it cannot interrupt publication.
        }
      }
    }
  };

  const acceptState = (state: AgentMonitorState, notify: boolean): boolean => {
    if (sealedEpochs.has(state.runtimeRunId)) {
      const sealedEpoch = sealedEpochs.get(state.runtimeRunId) ?? null;
      if (!isMonitorStateAfterRemoval(state, sealedEpoch)) return false;
      sealedEpochs.delete(state.runtimeRunId);
    }
    const current = statesByRunId.get(state.runtimeRunId);
    if (current && !isNewerMonitorRevision(state, current)) return false;
    statesByRunId.set(state.runtimeRunId, freezeTree(state));
    if (notify) publish();
    return true;
  };

  return {
    getSnapshot: () => snapshot,
    getState: (runtimeRunId) => statesByRunId.get(runtimeRunId),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acceptState: (state) => acceptState(state, true),
    acceptStates(states) {
      let accepted = 0;
      for (const state of states) {
        if (acceptState(state, false)) accepted += 1;
      }
      if (accepted > 0) publish();
      return accepted;
    },
    remove(removal) {
      const current = statesByRunId.get(removal.runtimeRunId);
      if (current && removal.runtimeEpoch !== null && isMonitorStateAfterRemoval(current, removal.runtimeEpoch)) {
        return false;
      }
      const existingSeal = sealedEpochs.get(removal.runtimeRunId);
      if (
        sealedEpochs.has(removal.runtimeRunId) &&
        (existingSeal === null ||
          (removal.runtimeEpoch !== null && existingSeal !== undefined && existingSeal >= removal.runtimeEpoch))
      ) {
        return false;
      }
      sealedEpochs.set(removal.runtimeRunId, removal.runtimeEpoch);
      const removed = statesByRunId.delete(removal.runtimeRunId);
      if (removed) publish();
      return true;
    },
    acceptNotification(notification) {
      if (
        notifications.some(
          (current) =>
            current.runtimeRunId === notification.runtimeRunId &&
            current.notificationId === notification.notificationId,
        )
      ) {
        return false;
      }
      const retained = notificationCapacity === 1 ? [] : notifications.slice(-(notificationCapacity - 1));
      notifications = [...retained, freezeTree(notification)];
      publish();
      return true;
    },
    dismissNotification(runtimeRunId, notificationId) {
      const next = notifications.filter(
        (notification) => notification.runtimeRunId !== runtimeRunId || notification.notificationId !== notificationId,
      );
      if (next.length === notifications.length) return false;
      notifications = next;
      publish();
      return true;
    },
    clear() {
      if (statesByRunId.size === 0 && sealedEpochs.size === 0 && notifications.length === 0) return;
      statesByRunId.clear();
      sealedEpochs.clear();
      notifications = [];
      publish();
    },
  };
}

export interface AgentMonitorSource {
  listStates(): Promise<readonly AgentMonitorState[]>;
  onState(listener: (state: AgentMonitorState) => void): () => void;
  onNotification(listener: (notification: MonitorNotification) => void): () => void;
  onRemoved(listener: (removal: AgentMonitorRemoval) => void): () => void;
}

export interface AgentMonitorConnection {
  /** Resolves after the initial snapshot has been merged with any concurrent live publications. */
  ready: Promise<void>;
  close(): void;
}

/** Subscribe before listing so live updates cannot be overwritten by an older initial snapshot. */
export function connectAgentMonitorStore(store: AgentMonitorStore, source: AgentMonitorSource): AgentMonitorConnection {
  let closed = false;
  const unsubscribers = [
    source.onState((state) => {
      if (!closed) store.acceptState(state);
    }),
    source.onNotification((notification) => {
      if (!closed) store.acceptNotification(notification);
    }),
    source.onRemoved((removal) => {
      if (!closed) store.remove(removal);
    }),
  ];
  const ready = source.listStates().then((states) => {
    if (!closed) store.acceptStates(states);
  });
  return {
    ready,
    close() {
      if (closed) return;
      closed = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
