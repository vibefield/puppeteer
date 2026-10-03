// A VIEW'S OWN WORKER, WITH ITS SAFETY NET (MV-D7: the view owns its worker).
//
// Ported from VibeField's swarm physics driver (GT-3c, GT-5c), made generic:
// any view that keeps a simulation off the main thread gets the same three
// guarantees.
//
// 1. PROOF OF LIFE. `new Worker(...)` returns before the module is fetched,
//    let alone evaluated, so a missing chunk in a packaged build or a CSP
//    refusal throws nothing at construction; it arrives later, or never. The
//    worker posts `WORKER_READY` once its imports have evaluated, and a worker
//    that has not spoken inside the deadline is presumed not to be coming.
// 2. DEMOTION WITH REPLAY. A worker that never proved itself is terminated and
//    the same simulation starts in this thread, handed the world the dead
//    worker was given: the latest command of each replayed kind. Gestures and
//    queries are not replayed — a pointer that was down four seconds ago is
//    not down now.
// 3. AN HONEST MODE. Where the simulation runs is observable, and the view
//    reports it (`commands.report({ physics })`), so a silent fall-back to the
//    main thread shows up as a failed row rather than as a working swarm.
//
// A worker that dies AFTER it proved itself is not rebuilt: replaying a whole
// world into a new thread mid-gesture would be half a fix. It is said out loud
// (`onError`) and the mode stays `worker`.
//
// How a view names its worker so that every host's bundler finds it is in
// README.md beside this file ("Workers and bundlers").

export type WorkerDriverMode = 'worker' | 'inline';

/** The proof of life a worker posts once its imports have evaluated. */
export const WORKER_READY = { type: 'ready' } as const;

export function isWorkerReadyMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === WORKER_READY.type;
}

/** What the driver needs of a worker: a DOM `Worker`, or a fixture. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
}

/** The same simulation in this thread: what a demoted driver posts to. */
export interface InlineEnd<Command> {
  post(command: Command, transfer?: Transferable[]): void;
  dispose(): void;
}

export interface WorkerDriverOptions<Command, Message> {
  /**
   * Builds the worker. A throw (no `Worker` at all, a URL that cannot be
   * formed, a refused construction) starts the simulation inline at once.
   */
  createWorker(): WorkerLike;
  /** Builds the simulation in this thread, delivering what it says through `deliver`. Called at most once. */
  createInline(deliver: (message: Message) => void): InlineEnd<Command>;
  /** Everything the simulation says, from either end, except the proof of life. */
  onMessage(message: Message): void;
  /** Recognises the proof of life. Default: `{ type: 'ready' }` (`WORKER_READY`). */
  isReady?(message: unknown): boolean;
  /**
   * Which commands make up the world a demotion replays: a key for each kind
   * whose latest command stands for it (`init`, `updateAgents`, …), `undefined`
   * for the rest. Never key a command that transfers ownership: its object
   * went to the dead worker. Default: nothing is replayed.
   */
  replayKey?(command: Command): string | undefined;
  /** How long a worker has to prove itself. Default 4 s: only a load that will never finish misses it. */
  readyTimeoutMs?: number;
  /** The simulation is running in this thread instead: why. For the host's log, never a toast. */
  onDemote?(reason: string): void;
  /** A worker that had proved itself died. The view says so on its stage. */
  onError?(detail: string, error: unknown): void;
}

export interface WorkerDriver<Command> {
  /** Where the simulation runs now. A getter: a demotion changes it after the driver is made. */
  readonly mode: WorkerDriverMode;
  post(command: Command, transfer?: Transferable[]): void;
  /** Calls `listener` with the mode now and again at every change; returns the stop. */
  observeMode(listener: (mode: WorkerDriverMode) => void): () => void;
  dispose(): void;
}

/** The default deadline for a worker's proof of life. */
export const WORKER_READY_TIMEOUT_MS = 4_000;

export function createWorkerDriver<Command, Message = unknown>(
  options: WorkerDriverOptions<Command, Message>,
): WorkerDriver<Command> {
  const isReady = options.isReady ?? isWorkerReadyMessage;
  const listeners = new Set<(mode: WorkerDriverMode) => void>();
  /** The world while the worker is unproven, latest command per key, in the order of each key's latest post. */
  const world = new Map<string, Command>();
  let mode: WorkerDriverMode = 'worker';
  let disposed = false;
  let fallback: InlineEnd<Command> | undefined;
  let worker: WorkerLike | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const setMode = (next: WorkerDriverMode): void => {
    if (mode === next) return;
    mode = next;
    for (const listener of [...listeners]) listener(next);
  };

  /** The worker has spoken, so it loaded: the watchdog stands down and the world is let go. */
  const settle = (): void => {
    if (deadline !== undefined) clearTimeout(deadline);
    deadline = undefined;
    world.clear();
  };

  const goInline = (reason: string, replay: readonly Command[]): void => {
    options.onDemote?.(reason);
    fallback = options.createInline((message) => options.onMessage(message));
    setMode('inline');
    for (const command of replay) fallback.post(command);
  };

  const demote = (reason: string): void => {
    // A deadline still armed IS the definition of "never proved it was live".
    if (disposed || fallback !== undefined || deadline === undefined) return;
    const replay = [...world.values()];
    settle();
    worker?.terminate();
    goInline(reason, replay);
  };

  try {
    worker = options.createWorker();
  } catch (error) {
    worker = undefined;
    goInline(`the worker would not start: ${error instanceof Error ? error.message : String(error)}`, []);
  }

  if (worker !== undefined) {
    worker.addEventListener('message', (event) => {
      if (disposed || fallback !== undefined) return;
      // ANY message proves the module evaluated; the proof of life most cheaply and first.
      settle();
      if (isReady(event.data)) return;
      options.onMessage(event.data as Message);
    });
    worker.addEventListener('error', (event) => {
      if (disposed || fallback !== undefined) return;
      const detail = event.message || 'unknown worker error';
      if (deadline !== undefined) demote(detail);
      else options.onError?.(detail, event.error);
    });
    deadline = setTimeout(
      () => demote('no ready message inside the deadline'),
      options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS,
    );
  }

  return {
    get mode() {
      return mode;
    },
    post(command, transfer) {
      if (disposed) return;
      if (fallback !== undefined) {
        fallback.post(command, transfer);
        return;
      }
      if (deadline !== undefined) {
        const key = options.replayKey?.(command);
        if (key !== undefined) {
          // Moved to the end: a re-sent `init` must come after what it replaces.
          world.delete(key);
          world.set(key, command);
        }
      }
      if (transfer && transfer.length > 0) worker?.postMessage(command, transfer);
      else worker?.postMessage(command);
    },
    observeMode(listener) {
      listeners.add(listener);
      listener(mode);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      settle();
      listeners.clear();
      if (fallback !== undefined) fallback.dispose();
      else worker?.terminate();
    },
  };
}

/** What `serveWorker` needs of the worker's global scope. */
export interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/**
 * The worker's end of the wire. Call it at the worker module's top level,
 * after its imports, so the proof of life it posts means everything above it
 * evaluated. Each command arrives at `onCommand`; `post` answers.
 */
export function serveWorker<Command>(
  onCommand: (command: Command) => void,
  scope: WorkerScopeLike = globalThis as unknown as WorkerScopeLike,
): { post(message: unknown, transfer?: Transferable[]): void } {
  scope.postMessage(WORKER_READY);
  scope.onmessage = (event) => onCommand(event.data as Command);
  return {
    post(message, transfer) {
      if (transfer && transfer.length > 0) scope.postMessage(message, transfer);
      else scope.postMessage(message);
    },
  };
}
