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
  it('publishes every valid record with replay-safe byte cursors before legacy filtering', async () => {
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
