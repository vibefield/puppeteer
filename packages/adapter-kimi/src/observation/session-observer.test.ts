import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKimiSessionObserver, type KimiObservedEvent, type KimiObservedRecord } from './session-observer.js';
import { encodeKimiWorkDirKey, kimiMainWirePath, type KimiSessionLocation } from './session-store.js';

const roots: string[] = [];

async function fixture(sessionId = 'session-1'): Promise<{
  home: string;
  cwd: string;
  location: KimiSessionLocation;
}> {
  const home = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-observer-'));
  roots.push(home);
  const cwd = join(home, 'repo');
  const sessionDir = join(home, 'sessions', encodeKimiWorkDirKey(cwd), sessionId);
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
  await writeFile(
    join(sessionDir, 'state.json'),
    JSON.stringify({ id: sessionId, cwd, createdAt: Date.UTC(2026, 0, 1), title: 'Observed Kimi' }),
  );
  return {
    home,
    cwd,
    location: {
      sessionId,
      sessionDir,
      workDir: cwd,
      wirePath: kimiMainWirePath(sessionDir),
      statePath: join(sessionDir, 'state.json'),
    },
  };
}

const lines = (...records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Kimi session observer', () => {
  it('publishes every valid record with replay-safe byte cursors before normalized-event selection', async () => {
    const { home, cwd, location } = await fixture('session-records');
    const metadata = { type: 'metadata', protocol_version: '1.5', created_at: 1 };
    const usage = {
      type: 'usage.record',
      model: 'kimi-alias',
      usageScope: 'turn',
      usage: { inputOther: 12, output: 3, inputCacheRead: 2, inputCacheCreation: 1 },
      time: Date.UTC(2026, 0, 1),
    };
    const raw = lines(metadata, usage);
    await writeFile(location.wirePath, raw);
    const observer = createKimiSessionObserver({
      kimiHome: home,
      cwd,
      location,
      replayOffsets: new Map([[location.wirePath, Buffer.byteLength(raw)]]),
      pollIntervalMs: 60_000,
      readChunkBytes: 17,
    });
    const records: KimiObservedRecord[] = [];
    const events: KimiObservedEvent[] = [];
    observer.onRecord((record) => records.push(record));
    observer.onEvent((event) => events.push(event));

    await observer.poll();

    const firstBytes = Buffer.byteLength(`${JSON.stringify(metadata)}\n`);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      agentId: 'main',
      record: usage,
      timestamp: '2026-01-01T00:00:00.000Z',
      replay: true,
      cursorStart: firstBytes,
      cursorEnd: Buffer.byteLength(raw),
    });
    expect(events.some(({ event }) => event.type === 'usage:tokens-used')).toBe(false);
    await observer.stop();
  });

  it('replays a resume boundary, tails partial appends once, and confirms only a live prompt echo', async () => {
    const { home, cwd, location } = await fixture();
    await writeFile(
      location.wirePath,
      lines(
        { type: 'metadata', protocol_version: '1.5', created_at: 1 },
        { type: 'turn.prompt', input: [{ type: 'text', text: 'history' }], origin: { kind: 'user' }, time: 2 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 1 }, time: 3 },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', turnId: '0', step: 1, part: { type: 'text', text: 'old' } },
          time: 4,
        },
        { type: 'turn.ended', turnId: 0, reason: 'completed', time: 5 },
      ),
    );
    const boundary = (await stat(location.wirePath)).size;
    const observer = createKimiSessionObserver({
      kimiHome: home,
      cwd,
      location,
      replayOffsets: new Map([[location.wirePath, boundary]]),
      pollIntervalMs: 60_000,
      readChunkBytes: 19,
    });
    const events: KimiObservedEvent[] = [];
    observer.onEvent((event) => events.push(event));
    await observer.poll();

    expect(events.find((entry) => entry.event.type === 'session:started')?.replay).toBeUndefined();
    expect(events.filter((entry) => entry.event.type === 'turn:started')).toMatchObject([
      { replay: true, event: { turnId: '0', prompt: 'history' } },
    ]);
    expect(events.find((entry) => entry.event.type === 'turn:completed')).toMatchObject({ replay: true });

    const expectation = observer.expectPrompt('live prompt', 2_000);
    const firstHalf = JSON.stringify({
      type: 'turn.prompt',
      input: [{ type: 'text', text: 'live prompt' }],
      origin: { kind: 'user' },
      time: 6,
    });
    await appendFile(location.wirePath, firstHalf.slice(0, 31));
    await observer.poll();
    expect(events.filter((entry) => entry.event.type === 'turn:started')).toHaveLength(1);
    await appendFile(location.wirePath, `${firstHalf.slice(31)}\n`);
    await appendFile(
      location.wirePath,
      lines(
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '1', step: 1 }, time: 7 },
        { type: 'turn.ended', turnId: 1, reason: 'completed', time: 8 },
      ),
    );
    await observer.poll();

    await expect(expectation.promise).resolves.toEqual({ matched: true, sessionId: 'session-1', text: 'live prompt' });
    expect(events.filter((entry) => entry.event.type === 'turn:started').at(-1)).toMatchObject({
      replay: false,
      event: { turnId: '1', prompt: 'live prompt' },
    });
    await observer.stop();
  });

  it('binds a fresh lazy session only after one new candidate records the matching prompt', async () => {
    const home = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-observer-'));
    roots.push(home);
    const cwd = join(home, 'repo');
    const observer = createKimiSessionObserver({
      kimiHome: home,
      cwd,
      baselineSessionIds: new Set(['old-session']),
      pollIntervalMs: 60_000,
    });
    const events: KimiObservedEvent[] = [];
    observer.onEvent((event) => events.push(event));
    const expectation = observer.expectPrompt('bind me', 2_000);

    const sessionId = 'new-session';
    const sessionDir = join(home, 'sessions', encodeKimiWorkDirKey(cwd), sessionId);
    const wirePath = kimiMainWirePath(sessionDir);
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ id: sessionId, cwd, createdAt: 1 }));
    await writeFile(
      wirePath,
      lines(
        { type: 'metadata', protocol_version: '1.5', created_at: 1 },
        { type: 'turn.prompt', input: [{ type: 'text', text: 'bind me' }], origin: { kind: 'user' }, time: 2 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 1 }, time: 3 },
      ),
    );

    expect(observer.sessionId()).toBeUndefined();
    await observer.poll();
    expect(observer.sessionId()).toBe(sessionId);
    await expect(expectation.promise).resolves.toMatchObject({ matched: true, sessionId });
    expect(events.map((entry) => entry.event.type)).toEqual(
      expect.arrayContaining(['session:started', 'environment:updated', 'turn:started']),
    );
    expect(events.find((entry) => entry.event.type === 'turn:started')).toMatchObject({ replay: false });
    await observer.stop();
  });

  describe('fresh runs in one folder bind by elimination', () => {
    /** A new Kimi session in the folder, as another process would start it: its state and a typed prompt. */
    async function startSession(home: string, cwd: string, sessionId: string, prompt: string): Promise<void> {
      const sessionDir = join(home, 'sessions', encodeKimiWorkDirKey(cwd), sessionId);
      await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
      await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ id: sessionId, cwd, createdAt: 1 }));
      await writeFile(
        kimiMainWirePath(sessionDir),
        lines(
          { type: 'metadata', protocol_version: '1.5', created_at: 1 },
          { type: 'turn.prompt', input: [{ type: 'text', text: prompt }], origin: { kind: 'user' }, time: 2 },
        ),
      );
    }
    const ambiguities = (events: KimiObservedEvent[]) =>
      events
        .filter(
          ({ event }) => event.type === 'adapter:native-event' && event.nativeType === 'session-discovery-ambiguous',
        )
        .map(({ nativeEvent }) =>
          (nativeEvent as { candidates: { sessionId: string }[] }).candidates.map(({ sessionId }) => sessionId).sort(),
        );

    it('in a home they own, leaves two candidates ambiguous until a peer binds one, then binds the other; a third started meanwhile stands', async () => {
      const home = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-peers-'));
      roots.push(home);
      const cwd = join(home, 'repo');
      const first = createKimiSessionObserver({ kimiHome: home, cwd, ownedRoot: true, pollIntervalMs: 60_000 });
      const second = createKimiSessionObserver({ kimiHome: home, cwd, ownedRoot: true, pollIntervalMs: 60_000 });
      const firstEvents: KimiObservedEvent[] = [];
      const secondEvents: KimiObservedEvent[] = [];
      first.onEvent((event) => firstEvents.push(event));
      second.onEvent((event) => secondEvents.push(event));
      first.onError(() => undefined);
      second.onError(() => undefined);
      await startSession(home, cwd, 'session-x', 'x');
      await startSession(home, cwd, 'session-y', 'y');

      await first.poll();
      await second.poll();
      expect([first.sessionId(), second.sessionId()]).toEqual([undefined, undefined]);
      expect(ambiguities(firstEvents)).toEqual([['session-x', 'session-y']]);
      // judged again at every poll, and said once per set
      await first.poll();
      expect(ambiguities(firstEvents)).toHaveLength(1);

      // the first run's own prompt names its session
      const echo = first.expectPrompt('x', 2_000);
      await first.poll();
      expect(first.sessionId()).toBe('session-x');
      await expect(echo.promise).resolves.toMatchObject({ matched: true, sessionId: 'session-x' });
      expect(firstEvents.find(({ event }) => event.type === 'session:started')?.event).toMatchObject({
        nativeSessionId: 'session-x',
        startSource: 'native-wire-bind',
      });

      // a session started in the meantime keeps the second ambiguous
      await startSession(home, cwd, 'session-z', 'z');
      await second.poll();
      expect(second.sessionId()).toBeUndefined();
      expect(ambiguities(secondEvents)).toEqual([
        ['session-x', 'session-y'],
        ['session-y', 'session-z'],
      ]);
      // its own prompt picks among what is left; the peer's session is never one of them
      const own = second.expectPrompt('y', 2_000);
      await second.poll();
      expect(second.sessionId()).toBe('session-y');
      await expect(own.promise).resolves.toMatchObject({ matched: true, sessionId: 'session-y' });
      await first.stop();
      await second.stop();
    });

    it('in a home it owns, binds the one session a peer left, and never a session a peer bound before it started', async () => {
      const home = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-peers-'));
      roots.push(home);
      const cwd = join(home, 'repo');
      const first = createKimiSessionObserver({ kimiHome: home, cwd, ownedRoot: true, pollIntervalMs: 60_000 });
      first.onError(() => undefined);
      await startSession(home, cwd, 'session-a', 'a');
      await startSession(home, cwd, 'session-b', 'b');
      const echo = first.expectPrompt('a', 2_000);
      await first.poll();
      expect(first.sessionId()).toBe('session-a');
      await echo.promise;
      // a run launched later in the same folder: the peer's session is in its baseline from the start
      const later = createKimiSessionObserver({ kimiHome: home, cwd, ownedRoot: true, pollIntervalMs: 60_000 });
      later.onError(() => undefined);
      await later.poll();
      expect(later.sessionId()).toBe('session-b');
      // a third run finds nothing left to bind
      const third = createKimiSessionObserver({ kimiHome: home, cwd, ownedRoot: true, pollIntervalMs: 60_000 });
      await third.poll();
      expect(third.sessionId()).toBeUndefined();
      await first.stop();
      await later.stop();
      await third.stop();
    });

    it('in a home it does not own, binds no session that holds none of its prompts, not even the one a peer left', async () => {
      const home = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-peers-'));
      roots.push(home);
      const cwd = join(home, 'repo');
      const first = createKimiSessionObserver({ kimiHome: home, cwd, pollIntervalMs: 60_000 });
      const second = createKimiSessionObserver({ kimiHome: home, cwd, pollIntervalMs: 60_000 });
      const secondEvents: KimiObservedEvent[] = [];
      second.onEvent((event) => secondEvents.push(event));
      first.onError(() => undefined);
      second.onError(() => undefined);
      await startSession(home, cwd, 'session-a', 'a');
      const echo = first.expectPrompt('a', 2_000);
      await first.poll();
      expect(first.sessionId()).toBe('session-a');
      await echo.promise;

      // a person starts Kimi in another terminal in the same folder: the one candidate the peer's bind leaves
      await startSession(home, cwd, 'session-outside', 'typed in another terminal');
      await second.poll();
      expect(second.sessionId()).toBeUndefined();
      // a run launched later in the folder takes it no more
      const later = createKimiSessionObserver({ kimiHome: home, cwd, pollIntervalMs: 60_000 });
      await later.poll();
      expect(later.sessionId()).toBeUndefined();
      // with no prompt of its own nothing is judged, so nothing is said ambiguous either
      expect(ambiguities(secondEvents)).toEqual([]);

      // the run's own prompt names its own session, and never the one from outside
      const own = second.expectPrompt('b', 2_000);
      await startSession(home, cwd, 'session-b', 'b');
      await second.poll();
      expect(second.sessionId()).toBe('session-b');
      await expect(own.promise).resolves.toMatchObject({ matched: true, sessionId: 'session-b' });
      await first.stop();
      await second.stop();
      await later.stop();
    });

    it('in a home it does not own, binds no session until its host saw input in the run’s own terminal, then binds the one new session', async () => {
      const home = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-input-'));
      roots.push(home);
      const cwd = join(home, 'repo');
      let typed = false;
      let asked = 0;
      const observer = createKimiSessionObserver({
        kimiHome: home,
        cwd,
        terminalInputSeen: () => {
          asked += 1;
          return typed;
        },
        pollIntervalMs: 60_000,
      });
      const events: KimiObservedEvent[] = [];
      observer.onEvent((event) => events.push(event));
      observer.onError(() => undefined);

      // no host prompt and no input to the run's terminal: the one new session may be another terminal's
      await startSession(home, cwd, 'session-new', 'typed somewhere');
      await observer.poll();
      await observer.poll();
      expect(observer.sessionId()).toBeUndefined();
      expect(asked).toBe(2);
      expect(events.some(({ event }) => event.type === 'session:started')).toBe(false);
      expect(ambiguities(events)).toEqual([]);

      // input reaches the run's own terminal: the next poll binds the one new session
      typed = true;
      await observer.poll();
      expect(observer.sessionId()).toBe('session-new');
      expect(events.find(({ event }) => event.type === 'session:started')?.event).toMatchObject({
        nativeSessionId: 'session-new',
        startSource: 'native-wire-bind',
      });
      await observer.stop();
    });

    it('with input seen, says two new sessions ambiguous; waits for a host answer that is a promise, and takes one that fails as not seen', async () => {
      const home = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-input-'));
      roots.push(home);
      const cwd = join(home, 'repo');
      const seen = createKimiSessionObserver({
        kimiHome: home,
        cwd,
        terminalInputSeen: () => Promise.resolve(true),
        pollIntervalMs: 60_000,
      });
      const seenEvents: KimiObservedEvent[] = [];
      seen.onEvent((event) => seenEvents.push(event));
      seen.onError(() => undefined);
      await startSession(home, cwd, 'session-x', 'x');
      await startSession(home, cwd, 'session-y', 'y');
      await seen.poll();
      expect(seen.sessionId()).toBeUndefined();
      expect(ambiguities(seenEvents)).toEqual([['session-x', 'session-y']]);

      const otherHome = await mkdtemp(join(tmpdir(), 'puppeteer-kimi-input-'));
      roots.push(otherHome);
      const otherCwd = join(otherHome, 'repo');
      const failing = createKimiSessionObserver({
        kimiHome: otherHome,
        cwd: otherCwd,
        terminalInputSeen: () => Promise.reject(new Error('the host cannot answer')),
        pollIntervalMs: 60_000,
      });
      const failingEvents: KimiObservedEvent[] = [];
      failing.onEvent((event) => failingEvents.push(event));
      await startSession(otherHome, otherCwd, 'session-one', 'one');
      await failing.poll();
      expect(failing.sessionId()).toBeUndefined();
      expect(failingEvents).toEqual([]);
      const answered = createKimiSessionObserver({
        kimiHome: otherHome,
        cwd: otherCwd,
        terminalInputSeen: async () => true,
        pollIntervalMs: 60_000,
      });
      await answered.poll();
      expect(answered.sessionId()).toBe('session-one');
      await seen.stop();
      await failing.stop();
      await answered.stop();
    });
  });

  it('performs a final bounded journal drain before stopping', async () => {
    const { home, cwd, location } = await fixture('session-drain');
    await writeFile(location.wirePath, lines({ type: 'metadata', protocol_version: '1.5', created_at: 1 }));
    const observer = createKimiSessionObserver({
      kimiHome: home,
      cwd,
      location,
      pollIntervalMs: 60_000,
    });
    const events: KimiObservedEvent[] = [];
    observer.onEvent((event) => events.push(event));
    await appendFile(
      location.wirePath,
      lines(
        { type: 'turn.prompt', input: [{ type: 'text', text: 'last turn' }], origin: { kind: 'user' }, time: 2 },
        { type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 1 }, time: 3 },
        { type: 'turn.ended', turnId: 0, reason: 'completed', time: 4 },
      ),
    );

    await observer.stop();

    expect(events.map((entry) => entry.event.type)).toEqual(
      expect.arrayContaining(['session:started', 'turn:started', 'turn:completed']),
    );
  });
});
