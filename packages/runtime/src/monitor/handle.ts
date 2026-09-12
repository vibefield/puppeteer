import type {
  AgentMonitorHandle,
  AgentMonitorState,
  MonitorArtifactReadResult,
  MonitorNotification,
} from '@vibecook/puppeteer-core';

export class MonitorNotificationGapError extends Error {
  readonly code = 'MONITOR_NOTIFICATION_GAP';

  constructor(readonly runtimeRunId: string) {
    super(`monitor notification stream overflowed for run ${runtimeRunId}; resubscribe for current state`);
    this.name = 'MonitorNotificationGapError';
  }
}

class ConflatedStateQueue implements AsyncIterable<AgentMonitorState> {
  private latest: AgentMonitorState | undefined;
  private waiter: ((result: IteratorResult<AgentMonitorState>) => void) | undefined;
  private closed = false;

  push(state: AgentMonitorState): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ done: false, value: state });
      return;
    }
    this.latest = state;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.latest !== undefined) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentMonitorState> {
    return {
      next: () => {
        if (this.latest !== undefined) {
          const value = this.latest;
          this.latest = undefined;
          return Promise.resolve({ done: false as const, value });
        }
        if (this.closed) return Promise.resolve({ done: true as const, value: undefined });
        if (this.waiter) {
          return Promise.reject(new Error('monitor state stream supports one active iterator per handle'));
        }
        return new Promise<IteratorResult<AgentMonitorState>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

class NotificationQueue implements AsyncIterable<MonitorNotification> {
  private readonly values: MonitorNotification[] = [];
  private waiter:
    | {
        resolve: (result: IteratorResult<MonitorNotification>) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private closed = false;
  private failure: Error | undefined;

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('monitor notification capacity must be a positive safe integer');
    }
  }

  push(notification: MonitorNotification, overflowError: Error): void {
    if (this.closed || this.failure) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter.resolve({ done: false, value: notification });
      return;
    }
    if (this.values.length >= this.capacity) {
      this.values.length = 0;
      this.failure = overflowError;
      return;
    }
    this.values.push(notification);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.values.length > 0 || this.failure) return;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<MonitorNotification> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false as const, value });
        if (this.failure) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ done: true as const, value: undefined });
        if (this.waiter) {
          return Promise.reject(new Error('monitor notification stream supports one active iterator per handle'));
        }
        return new Promise<IteratorResult<MonitorNotification>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}

export interface MonitorHandleSubscriber {
  publishState(state: AgentMonitorState): void;
  publishNotification(notification: MonitorNotification): void;
  close(): void;
}

export interface MonitorHandleSource {
  readonly runtimeRunId: string;
  current(): AgentMonitorState;
  subscribe(subscriber: MonitorHandleSubscriber): () => void;
  readArtifact(artifactId: string, options?: { maxBytes?: number | undefined }): Promise<MonitorArtifactReadResult>;
}

export function createMonitorHandle(source: MonitorHandleSource, notificationCapacity: number): AgentMonitorHandle {
  const states = new ConflatedStateQueue();
  const notifications = new NotificationQueue(notificationCapacity);
  let current: AgentMonitorState | undefined;
  let closed = false;

  const acceptState = (state: AgentMonitorState): void => {
    if (closed) return;
    if (
      current &&
      (state.runtimeEpoch < current.runtimeEpoch ||
        (state.runtimeEpoch === current.runtimeEpoch && state.revision <= current.revision))
    ) {
      return;
    }
    current = state;
    states.push(state);
  };

  const subscriber: MonitorHandleSubscriber = {
    publishState: acceptState,
    publishNotification(notification) {
      if (closed) return;
      notifications.push(notification, new MonitorNotificationGapError(source.runtimeRunId));
    },
    close() {
      states.close();
      notifications.close();
    },
  };

  // Subscribe before reading the snapshot. Any publication in between is
  // either accepted first or rejected as an older/equal revision below.
  const unsubscribe = source.subscribe(subscriber);
  const snapshot = source.current();
  acceptState(snapshot);

  return {
    states,
    notifications,
    ready: Promise.resolve(snapshot),
    current: () => current,
    readArtifact: (artifactId, options) => source.readArtifact(artifactId, options),
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      states.close();
      notifications.close();
    },
  };
}
