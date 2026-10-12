import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerDriver,
  isWorkerReadyMessage,
  serveWorker,
  WORKER_READY,
  WORKER_READY_TIMEOUT_MS,
  type InlineEnd,
  type WorkerDriverMode,
  type WorkerLike,
  type WorkerScopeLike,
} from './worker.js';

type Command = { type: 'init' | 'updateAgents' | 'updateBounds' | 'dragMove' | 'adoptCanvas'; value?: number };

class FakeWorker implements WorkerLike {
  readonly posted: { message: unknown; transfer?: Transferable[] }[] = [];
  terminated = false;
  private readonly onMessage = new Set<(event: MessageEvent) => void>();
  private readonly onError = new Set<(event: ErrorEvent) => void>();

  postMessage(message: unknown, transfer: Transferable[]): void;
  postMessage(message: unknown): void;
  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push(transfer === undefined ? { message } : { message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent) => void) | ((event: ErrorEvent) => void),
  ) {
    if (type === 'message') this.onMessage.add(listener as (event: MessageEvent) => void);
    else this.onError.add(listener as (event: ErrorEvent) => void);
  }

  say(data: unknown): void {
    for (const listener of this.onMessage) listener({ data } as MessageEvent);
  }

  die(message: string, error: unknown = new Error(message)): void {
    for (const listener of this.onError) listener({ message, error } as ErrorEvent);
  }
}

/** The inline end: records what it is handed, and can speak through the driver. */
function fakeInline() {
  const state = {
    created: 0,
    posts: [] as { command: Command; transfer?: Transferable[] }[],
    disposed: false,
    deliver: undefined as ((message: unknown) => void) | undefined,
  };
  const factory = (deliver: (message: unknown) => void): InlineEnd<Command> => {
    state.created += 1;
    state.deliver = deliver;
    return {
      post: (command, transfer) => state.posts.push(transfer === undefined ? { command } : { command, transfer }),
      dispose: () => {
        state.disposed = true;
      },
    };
  };
  return { state, factory };
}

const swarmReplayKey = (command: Command): string | undefined =>
  command.type === 'init' || command.type === 'updateAgents' || command.type === 'updateBounds'
    ? command.type
    : undefined;

function setup(overrides: { createWorker?: () => WorkerLike; readyTimeoutMs?: number } = {}) {
  const worker = new FakeWorker();
  const inline = fakeInline();
  const messages: unknown[] = [];
  const demotions: string[] = [];
  const errors: string[] = [];
  const modes: WorkerDriverMode[] = [];
  const driver = createWorkerDriver<Command>({
    createWorker: overrides.createWorker ?? (() => worker),
    createInline: inline.factory,
    onMessage: (message) => messages.push(message),
    replayKey: swarmReplayKey,
    onDemote: (reason) => demotions.push(reason),
    onError: (detail) => errors.push(detail),
    ...(overrides.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: overrides.readyTimeoutMs }),
  });
  driver.observeMode((mode) => modes.push(mode));
  return { worker, inline: inline.state, messages, demotions, errors, modes, driver };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a worker that proves itself', () => {
  it('carries commands to the worker and everything but the proof of life back', () => {
    const { worker, messages, modes, driver } = setup();
    driver.post({ type: 'init', value: 1 });
    worker.say(WORKER_READY);
    worker.say({ type: 'idTable' });
    const frame = new Float32Array(4);
    worker.say(frame);
    expect(worker.posted.map((post) => post.message)).toEqual([{ type: 'init', value: 1 }]);
    expect(messages).toEqual([{ type: 'idTable' }, frame]);
    expect(driver.mode).toBe('worker');
    expect(modes).toEqual(['worker']);
  });

  it('stands the watchdog down once it has spoken', () => {
    const { worker, demotions, driver } = setup();
    worker.say(WORKER_READY);
    vi.advanceTimersByTime(WORKER_READY_TIMEOUT_MS * 3);
    expect(driver.mode).toBe('worker');
    expect(worker.terminated).toBe(false);
    expect(demotions).toEqual([]);
  });

  it('counts any message as proof that the module evaluated', () => {
    const { worker, messages, driver } = setup();
    worker.say({ type: 'idTable' });
    vi.advanceTimersByTime(WORKER_READY_TIMEOUT_MS + 1);
    expect(driver.mode).toBe('worker');
    expect(messages).toEqual([{ type: 'idTable' }]);
  });

  it('passes transferables through', () => {
    const { worker, driver } = setup();
    const buffer = new ArrayBuffer(8);
    driver.post({ type: 'dragMove' }, [buffer]);
    driver.post({ type: 'dragMove' }, []);
    expect(worker.posted).toEqual([
      { message: { type: 'dragMove' }, transfer: [buffer] },
      { message: { type: 'dragMove' } },
    ]);
  });

  it('says out loud when a proven worker dies, and does not pretend to rebuild it', () => {
    const { worker, errors, demotions, inline, driver } = setup();
    worker.say(WORKER_READY);
    worker.die('out of memory');
    expect(errors).toEqual(['out of memory']);
    expect(demotions).toEqual([]);
    expect(inline.created).toBe(0);
    expect(driver.mode).toBe('worker');
  });
});

describe('a worker that never proves itself', () => {
  it('is demoted at the deadline, and the inline end gets the world it was given', () => {
    const { worker, inline, demotions, modes, driver } = setup();
    driver.post({ type: 'init', value: 1 });
    driver.post({ type: 'updateAgents', value: 2 });
    driver.post({ type: 'dragMove', value: 3 });
    driver.post({ type: 'updateBounds', value: 4 });
    driver.post({ type: 'updateAgents', value: 5 });
    vi.advanceTimersByTime(WORKER_READY_TIMEOUT_MS - 1);
    expect(driver.mode).toBe('worker');
    vi.advanceTimersByTime(1);
    expect(worker.terminated).toBe(true);
    expect(driver.mode).toBe('inline');
    expect(modes).toEqual(['worker', 'inline']);
    expect(demotions).toEqual(['no ready message inside the deadline']);
    // The latest of each kind, gestures dropped, each kind where it was last sent.
    expect(inline.posts.map((post) => post.command)).toEqual([
      { type: 'init', value: 1 },
      { type: 'updateBounds', value: 4 },
      { type: 'updateAgents', value: 5 },
    ]);
  });

  it('replays a re-sent init after what it replaced', () => {
    const { inline, driver } = setup();
    driver.post({ type: 'init', value: 1 });
    driver.post({ type: 'updateAgents', value: 2 });
    driver.post({ type: 'init', value: 3 });
    vi.advanceTimersByTime(WORKER_READY_TIMEOUT_MS);
    expect(inline.posts.map((post) => post.command)).toEqual([
      { type: 'updateAgents', value: 2 },
      { type: 'init', value: 3 },
    ]);
  });

  it('is demoted at once when it fails to load', () => {
    const { worker, demotions, driver } = setup();
    worker.die('Failed to fetch a worker script');
    expect(worker.terminated).toBe(true);
    expect(driver.mode).toBe('inline');
    expect(demotions).toEqual(['Failed to fetch a worker script']);
  });

  it('sends everything after a demotion to the inline end, which answers through the same door', () => {
    const { worker, inline, messages, driver } = setup();
    vi.advanceTimersByTime(WORKER_READY_TIMEOUT_MS);
    const buffer = new ArrayBuffer(8);
    driver.post({ type: 'dragMove', value: 9 }, [buffer]);
    inline.deliver?.({ type: 'queryResult' });
    worker.say({ type: 'late' });
    expect(inline.posts).toEqual([{ command: { type: 'dragMove', value: 9 }, transfer: [buffer] }]);
    expect(messages).toEqual([{ type: 'queryResult' }]);
    expect(worker.posted).toEqual([]);
  });

  it('honours its own deadline and its own proof of life', () => {
    const worker = new FakeWorker();
    const inline = fakeInline();
    const delivered: unknown[] = [];
    const driver = createWorkerDriver<Command>({
      createWorker: () => worker,
      createInline: inline.factory,
      onMessage: (message) => delivered.push(message),
      isReady: (message) => message === 'hello',
      readyTimeoutMs: 100,
    });
    worker.say('hello');
    worker.say({ type: 'ready' });
    vi.advanceTimersByTime(100);
    expect(driver.mode).toBe('worker');
    // Its own proof of life is swallowed; the default's shape is just another message here.
    expect(delivered).toEqual([{ type: 'ready' }]);

    const silent = new FakeWorker();
    const other = createWorkerDriver<Command>({
      createWorker: () => silent,
      createInline: fakeInline().factory,
      onMessage: () => {},
      readyTimeoutMs: 100,
    });
    vi.advanceTimersByTime(100);
    expect(other.mode).toBe('inline');
  });
});

describe('no worker at all', () => {
  it('starts inline at once when the worker cannot be made, and arms no watchdog', () => {
    const { inline, demotions, modes, driver } = setup({
      createWorker: () => {
        throw new TypeError("Failed to construct 'URL': Invalid URL");
      },
    });
    expect(driver.mode).toBe('inline');
    expect(modes).toEqual(['inline']);
    expect(demotions).toEqual(["the worker would not start: Failed to construct 'URL': Invalid URL"]);
    driver.post({ type: 'init', value: 1 });
    expect(inline.posts.map((post) => post.command)).toEqual([{ type: 'init', value: 1 }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('disposal', () => {
  it('terminates the worker, stands the watchdog down, and drops anything later', () => {
    const { worker, inline, messages, demotions, driver } = setup();
    driver.dispose();
    expect(worker.terminated).toBe(true);
    vi.advanceTimersByTime(WORKER_READY_TIMEOUT_MS);
    worker.say({ type: 'late' });
    driver.post({ type: 'init' });
    expect(demotions).toEqual([]);
    expect(inline.created).toBe(0);
    expect(messages).toEqual([]);
    expect(worker.posted).toEqual([]);
  });

  it('disposes the inline end after a demotion', () => {
    const { inline, driver } = setup();
    vi.advanceTimersByTime(WORKER_READY_TIMEOUT_MS);
    driver.dispose();
    expect(inline.disposed).toBe(true);
  });

  it('stops telling anyone about the mode', () => {
    const { modes, driver } = setup();
    const seen: WorkerDriverMode[] = [];
    const stop = driver.observeMode((mode) => seen.push(mode));
    stop();
    vi.advanceTimersByTime(WORKER_READY_TIMEOUT_MS);
    expect(seen).toEqual(['worker']);
    expect(modes).toEqual(['worker', 'inline']);
  });
});

describe("the worker's end", () => {
  it('proves it loaded first, then hands every command on', () => {
    const sent: { message: unknown; transfer?: Transferable[] }[] = [];
    const scope: WorkerScopeLike = {
      onmessage: null,
      postMessage: (message, transfer) => sent.push(transfer === undefined ? { message } : { message, transfer }),
    };
    const commands: unknown[] = [];
    const end = serveWorker((command) => commands.push(command), scope);
    expect(sent).toEqual([{ message: WORKER_READY }]);
    expect(isWorkerReadyMessage(sent[0]!.message)).toBe(true);
    scope.onmessage?.({ data: { type: 'init' } } as MessageEvent);
    expect(commands).toEqual([{ type: 'init' }]);
    const frame = new Float32Array(2);
    end.post(frame, [frame.buffer]);
    end.post({ type: 'idTable' });
    expect(sent.slice(1)).toEqual([{ message: frame, transfer: [frame.buffer] }, { message: { type: 'idTable' } }]);
  });

  it('closes its own thread when told, taking no more commands (the view never names the global, MV-W2)', () => {
    let closed = 0;
    const scope: WorkerScopeLike = { onmessage: null, postMessage: () => undefined, close: () => (closed += 1) };
    const commands: unknown[] = [];
    const end = serveWorker((command) => commands.push(command), scope);
    end.close();
    expect(closed).toBe(1);
    expect(scope.onmessage).toBeNull();
    // A scope that cannot close itself (a test's, an inline host's) is simply let go.
    const quiet: WorkerScopeLike = { onmessage: null, postMessage: () => undefined };
    expect(() => serveWorker(() => undefined, quiet).close()).not.toThrow();
  });
});

// A DOM Worker is a WorkerLike, so a view writes `createWorker: () => new Worker(url, { type: 'module' })`.
export const domWorkerIsWorkerLike: (worker: Worker) => WorkerLike = (worker) => worker;
