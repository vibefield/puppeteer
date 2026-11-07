import { appendFile, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrokObservedEvent, GrokSessionObserver } from '../normalization/types.js';
import { createGrokSessionObserver } from './session-observer.js';

const memory = vi.hoisted(() => ({ files: undefined as Map<string, string> | undefined }));

// The calls a poll makes, counted. With `memory.files` set they answer from it in resolved promises alone, so fake
// timers advance exactly.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const read = (path: string): string => {
    const text = memory.files?.get(path);
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return text;
  };
  return {
    ...actual,
    stat: vi.fn(async (path: string) =>
      memory.files ? { mtimeMs: 1, size: Buffer.byteLength(read(path)), ino: 1 } : actual.stat(path),
    ),
    readFile: vi.fn(async (path: string, encoding: BufferEncoding) =>
      memory.files ? read(path) : actual.readFile(path, encoding),
    ),
    open: vi.fn(async (path: string, flags: string) => {
      if (!memory.files) return actual.open(path, flags);
      const bytes = Buffer.from(read(path));
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
          bytesRead: bytes.copy(buffer, offset, position, position + length),
        }),
        close: async (): Promise<void> => undefined,
      };
    }),
  };
});

const readsOf = (path: string) => vi.mocked(readFile).mock.calls.filter(([read]) => read === path).length;
const opensOf = (path: string) => vi.mocked(open).mock.calls.filter(([opened]) => opened === path).length;

function sessionStart(padding = ''): string {
  const update = { sessionUpdate: 'hook_execution', event_name: 'session_start' };
  return `${JSON.stringify({ method: 'session/update', padding, params: { sessionId: 'session', update } })}\n`;
}

describe('createGrokSessionObserver stat gating', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function session() {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-cadence-'));
    directories.push(directory);
    const paths = {
      updatesPath: join(directory, 'updates.jsonl'),
      signalsPath: join(directory, 'signals.json'),
      summaryPath: join(directory, 'summary.json'),
    };
    await writeFile(paths.updatesPath, sessionStart('padding'));
    await writeFile(paths.signalsPath, JSON.stringify({ contextTokensUsed: 10, contextWindowTokens: 1_000 }));
    await writeFile(paths.summaryPath, JSON.stringify({ info: { cwd: '/repo' } }));
    vi.clearAllMocks();
    return paths;
  }

  it('reads an unchanged file once, and an append on the next poll', async () => {
    const { updatesPath, signalsPath, summaryPath } = await session();
    const observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000 });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    try {
      for (let poll = 0; poll < 3; poll += 1) await observer.poll();
      expect([readsOf(signalsPath), readsOf(summaryPath), opensOf(updatesPath)]).toEqual([1, 1, 1]);

      await appendFile(updatesPath, sessionStart());
      await observer.poll();
      expect(opensOf(updatesPath)).toBe(2);
      expect(received.filter(({ event }) => event.type === 'session:started')).toHaveLength(2);
    } finally {
      observer.stop();
    }
  });

  it('reads a partial rewrite again on every poll until it parses', async () => {
    const { updatesPath, signalsPath, summaryPath } = await session();
    await writeFile(signalsPath, '{"contextTokensUsed":');
    await writeFile(summaryPath, '{"info":');
    const observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000 });
    try {
      await observer.poll();
      await observer.poll();
      expect([readsOf(signalsPath), readsOf(summaryPath)]).toEqual([2, 2]);
    } finally {
      observer.stop();
    }
  });

  it('reads a truncated log again from its start', async () => {
    const { updatesPath } = await session();
    const observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000 });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    try {
      await observer.poll();
      await writeFile(updatesPath, sessionStart());
      await observer.poll();
      expect(received.filter(({ event }) => event.type === 'session:started')).toHaveLength(2);
    } finally {
      observer.stop();
    }
  });
});

describe('createGrokSessionObserver cadence', () => {
  const updatesPath = '/grok/session/updates.jsonl';
  const signalsPath = '/grok/session/signals.json';
  let observer: GrokSessionObserver | undefined;

  /** Every poll stats signals.json once. */
  const polls = () => vi.mocked(stat).mock.calls.filter(([path]) => path === signalsPath).length;
  const pollsWithin = async (ms: number) => {
    const before = polls();
    await vi.advanceTimersByTimeAsync(ms);
    return polls() - before;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    memory.files = new Map([
      [updatesPath, ''],
      [signalsPath, '{}'],
      ['/grok/session/summary.json', '{}'],
    ]);
  });

  afterEach(() => {
    observer?.stop();
    observer = undefined;
    memory.files = undefined;
    vi.useRealTimers();
  });

  it('drops to the idle cadence a second after the last change', async () => {
    observer = createGrokSessionObserver(updatesPath);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pollsWithin(1_000)).toBe(1);
  });

  it('brings the next poll to the fast cadence when the rail wakes it', async () => {
    const started = createGrokSessionObserver(updatesPath);
    observer = started;
    await vi.advanceTimersByTimeAsync(2_200);
    started.wake();
    expect(await pollsWithin(74)).toBe(0);
    expect(await pollsWithin(1)).toBe(1);
  });

  it('polls at the fast cadence through a burst of wakes, never once per wake', async () => {
    const started = createGrokSessionObserver(updatesPath);
    observer = started;
    await vi.advanceTimersByTimeAsync(2_200);
    const before = polls();
    for (let elapsed = 0; elapsed < 300; elapsed += 10) {
      started.wake();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(polls() - before).toBe(4);
  });

  it('keeps the fast cadence for a second after an append', async () => {
    observer = createGrokSessionObserver(updatesPath);
    await vi.advanceTimersByTimeAsync(2_125);
    memory.files?.set(updatesPath, sessionStart());
    // The idle poll a second later reads it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pollsWithin(1_000)).toBe(13);
  });

  it('never idles faster than a slower fast cadence', async () => {
    observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000 });
    expect(await pollsWithin(59_999)).toBe(0);
    expect(await pollsWithin(60_001)).toBe(2);
  });

  it('leaves no timer once stopped, however it is woken after', async () => {
    const started = createGrokSessionObserver(updatesPath);
    started.stop();
    started.wake();
    expect(vi.getTimerCount()).toBe(0);
  });
});
