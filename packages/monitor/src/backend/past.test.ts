import { describe, expect, it } from 'vitest';
import type { MonitorPastSnapshot, MonitorPastSpanKind } from '@vibecook/puppeteer-view-sdk/model';
import { createMemoryProjectIdentityStore } from './identity.js';
import {
  clampPastWindow,
  derivePast,
  PAST_MAX_WINDOW_MS,
  PAST_SILENCE_MS,
  spansFromTurns,
  type DerivePastInput,
} from './past.js';
import type { MonitorHistoryPort, MonitorRecordedActivity, MonitorRecordedSession } from './ports.js';
import { DEVICE, T0, facts, hostRun, iso, monitorState, testBackend } from './testing/fixtures.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const WINDOW = { sinceMs: T0 - 4 * HOUR, untilMs: T0 };
const CLAUDE = { id: 'claude', label: 'Claude Code' };
const KINDS: readonly MonitorPastSpanKind[] = ['worked', 'quiet', 'unrecorded', 'bounds'];

function session(overrides: Partial<MonitorRecordedSession> = {}): MonitorRecordedSession {
  return {
    provider: CLAUDE,
    nativeSessionId: 'native-1',
    startedAt: T0 - 3 * HOUR,
    firstAt: T0 - 3 * HOUR,
    lastAt: T0 - 2 * HOUR,
    projectKey: '/Users/me/code/billing-api',
    ...overrides,
  };
}

function input(overrides: Partial<DerivePastInput> = {}): DerivePastInput {
  return {
    window: WINDOW,
    activity: { fidelity: 'turns', partial: false, sessions: [] },
    live: [],
    device: DEVICE,
    identity: createMemoryProjectIdentityStore(),
    readAt: T0,
    ...overrides,
  };
}

function allSpanKinds(past: MonitorPastSnapshot): MonitorPastSpanKind[] {
  return [...past.live, ...past.ended].flatMap((lane) => lane.spans.map((span) => span.kind));
}

describe('spansFromTurns: worked inside a turn, quiet between turns', () => {
  it('draws two turns as worked with the quiet between them, clipped to the window', () => {
    const turns = [
      { firstAt: T0 - 5 * HOUR, lastAt: T0 - 3 * HOUR - 50 * MIN },
      { firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR },
    ];
    expect(spansFromTurns(turns, WINDOW.sinceMs, T0 - 2 * HOUR)).toEqual([
      { kind: 'worked', from: T0 - 4 * HOUR, to: T0 - 3 * HOUR - 50 * MIN },
      { kind: 'quiet', from: T0 - 3 * HOUR - 50 * MIN, to: T0 - 3 * HOUR },
      { kind: 'worked', from: T0 - 3 * HOUR, to: T0 - 2 * HOUR },
    ]);
  });

  it('keeps a silence longer than 15 min inside a turn not recorded, and a shorter one worked', () => {
    const turn = {
      firstAt: T0 - 2 * HOUR,
      lastAt: T0 - HOUR,
      silences: [
        { from: T0 - 2 * HOUR + 5 * MIN, to: T0 - 2 * HOUR + 15 * MIN }, // ten minutes: still worked
        { from: T0 - 2 * HOUR + 20 * MIN, to: T0 - 2 * HOUR + 50 * MIN }, // thirty: the record cannot say
      ],
    };
    expect(spansFromTurns([turn], T0 - 2 * HOUR, T0 - HOUR)).toEqual([
      { kind: 'worked', from: T0 - 2 * HOUR, to: T0 - 2 * HOUR + 20 * MIN },
      { kind: 'unrecorded', from: T0 - 2 * HOUR + 20 * MIN, to: T0 - 2 * HOUR + 50 * MIN },
      { kind: 'worked', from: T0 - 2 * HOUR + 50 * MIN, to: T0 - HOUR },
    ]);
  });

  it('cuts exactly at the threshold: a silence of 15 min is worked, one past it is not', () => {
    const at = T0 - HOUR;
    const exactly = { firstAt: at, lastAt: at + HOUR, silences: [{ from: at + MIN, to: at + MIN + PAST_SILENCE_MS }] };
    expect(spansFromTurns([exactly], at, at + HOUR).map((span) => span.kind)).toEqual(['worked']);
    const past = { ...exactly, silences: [{ from: at + MIN, to: at + MIN + PAST_SILENCE_MS + 1 }] };
    expect(spansFromTurns([past], at, at + HOUR).map((span) => span.kind)).toEqual(['worked', 'unrecorded', 'worked']);
  });

  it('lets an overlapping turn (a delegated thread) cover another turn’s silence', () => {
    const parent = {
      firstAt: T0 - 2 * HOUR,
      lastAt: T0 - HOUR,
      silences: [{ from: T0 - 2 * HOUR + 10 * MIN, to: T0 - HOUR - 10 * MIN }],
    };
    const thread = { firstAt: T0 - 2 * HOUR + 10 * MIN, lastAt: T0 - HOUR - 10 * MIN };
    expect(spansFromTurns([parent, thread], T0 - 2 * HOUR, T0 - HOUR)).toEqual([
      { kind: 'worked', from: T0 - 2 * HOUR, to: T0 - HOUR },
    ]);
  });

  it('is quiet from the window’s start to a first turn when the session began before it', () => {
    const turns = [{ firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR }];
    expect(spansFromTurns(turns, WINDOW.sinceMs, T0 - 2 * HOUR)).toEqual([
      { kind: 'quiet', from: WINDOW.sinceMs, to: T0 - 3 * HOUR },
      { kind: 'worked', from: T0 - 3 * HOUR, to: T0 - 2 * HOUR },
    ]);
  });
});

describe('derivePast', () => {
  it('the floor: an ended run is ONE bounds span from its first to its last activity', () => {
    const past = derivePast(input({ activity: { fidelity: 'bounds', partial: false, sessions: [session()] } }));
    expect(past.fidelity).toBe('bounds');
    expect(past.live).toEqual([]);
    expect(past.ended).toEqual([
      {
        id: 'past:claude:native-1',
        provider: CLAUDE,
        project: { name: 'billing-api', seq: 0 },
        device: DEVICE,
        startedAt: T0 - 3 * HOUR,
        endedAt: T0 - 2 * HOUR,
        spans: [{ kind: 'bounds', from: T0 - 3 * HOUR, to: T0 - 2 * HOUR }],
      },
    ]);
  });

  it('the floor keeps a live row’s past unrecorded: no live past from bounds alone', () => {
    const past = derivePast(
      input({
        activity: { fidelity: 'bounds', partial: false, sessions: [session({ lastAt: T0 })] },
        live: [{ id: 'pty-1', providerId: 'claude', nativeSessionId: 'native-1', statusSince: T0 - 10 * MIN }],
      }),
    );
    expect(past.live).toEqual([]);
    expect(past.ended).toEqual([]);
  });

  it('joins a live row by provider and native id and gives its past up to the seam at statusSince', () => {
    const recorded = session({
      lastAt: T0,
      turns: [
        { firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR },
        { firstAt: T0 - 30 * MIN, lastAt: T0 },
      ],
    });
    const past = derivePast(
      input({
        activity: { fidelity: 'turns', partial: false, sessions: [recorded] },
        live: [{ id: 'pty-1', providerId: 'claude', nativeSessionId: 'native-1', statusSince: T0 - 10 * MIN }],
      }),
    );
    expect(past.ended).toEqual([]);
    expect(past.live).toEqual([
      {
        id: 'pty-1',
        seamAt: T0 - 10 * MIN,
        spans: [
          { kind: 'worked', from: T0 - 3 * HOUR, to: T0 - 2 * HOUR },
          { kind: 'quiet', from: T0 - 2 * HOUR, to: T0 - 30 * MIN },
          { kind: 'worked', from: T0 - 30 * MIN, to: T0 - 10 * MIN },
        ],
      },
    ]);
  });

  it('never joins across providers: the same native id under another provider is its own ended lane', () => {
    const past = derivePast(
      input({
        activity: {
          fidelity: 'turns',
          partial: false,
          sessions: [session({ provider: { id: 'codex', label: 'Codex' }, turns: [] })],
        },
        live: [{ id: 'pty-1', providerId: 'claude', nativeSessionId: 'native-1', statusSince: T0 }],
      }),
    );
    expect(past.live).toEqual([]);
    expect(past.ended.map((lane) => lane.id)).toEqual(['past:codex:native-1']);
  });

  it('orders ended lanes by birth, deals their project colour once, and says partial when the record did', () => {
    const identity = createMemoryProjectIdentityStore();
    identity.deal('/Users/me/code/vibe-field');
    const past = derivePast(
      input({
        identity,
        activity: {
          fidelity: 'bounds',
          partial: true,
          detail: 'The agent index has not read every session yet',
          sessions: [
            session({ nativeSessionId: 'late', startedAt: T0 - HOUR, firstAt: T0 - HOUR, lastAt: T0 - 30 * MIN }),
            session({ nativeSessionId: 'early', projectKey: '/Users/me/code/vibe-field' }),
          ],
        },
      }),
    );
    expect(past.state).toBe('partial');
    expect(past.detail).toBe('The agent index has not read every session yet');
    expect(past.ended.map((lane) => [lane.id, lane.project])).toEqual([
      ['past:claude:early', { name: 'vibe-field', seq: 0 }],
      ['past:claude:late', { name: 'billing-api', seq: 1 }],
    ]);
  });

  it('leaves out a session whose activity misses the window, and never names blocked or unseen', () => {
    const past = derivePast(
      input({
        activity: {
          fidelity: 'turns',
          partial: false,
          sessions: [
            session({ nativeSessionId: 'old', firstAt: T0 - 30 * HOUR, lastAt: T0 - 29 * HOUR, turns: [] }),
            session({
              turns: [
                {
                  firstAt: T0 - 3 * HOUR,
                  lastAt: T0 - 2 * HOUR,
                  silences: [{ from: T0 - 3 * HOUR + MIN, to: T0 - 2 * HOUR - MIN }],
                },
              ],
            }),
          ],
        },
      }),
    );
    expect(past.ended.map((lane) => lane.id)).toEqual(['past:claude:native-1']);
    for (const kind of allSpanKinds(past)) expect(KINDS).toContain(kind);
    expect(allSpanKinds(past)).toEqual(['worked', 'unrecorded', 'worked']);
  });
});

describe('clampPastWindow', () => {
  it('bounds an ask to the day before its end, and refuses one that names no time', () => {
    expect(clampPastWindow({ sinceMs: T0 - 3 * PAST_MAX_WINDOW_MS, untilMs: T0 })).toEqual({
      sinceMs: T0 - PAST_MAX_WINDOW_MS,
      untilMs: T0,
    });
    expect(clampPastWindow({ sinceMs: T0, untilMs: T0 })).toBeUndefined();
    expect(clampPastWindow({ sinceMs: Number.NaN, untilMs: T0 })).toBeUndefined();
  });
});

function fakeHistory(answer: MonitorRecordedActivity | Error): MonitorHistoryPort & { asks: unknown[] } {
  const asks: unknown[] = [];
  return {
    asks,
    async read(window, options) {
      asks.push({ window, silenceMs: options.silenceMs });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe('the backend’s readPast', () => {
  it('joins the record with the model as it is: the row’s id, its statusSince as the seam, the rest ended', async () => {
    const history = fakeHistory({
      fidelity: 'turns',
      partial: false,
      sessions: [
        session({ lastAt: T0, turns: [{ firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR }] }),
        session({ nativeSessionId: 'native-gone', turns: [{ firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR }] }),
      ],
    });
    const t = testBackend({
      facts: facts({ runs: [hostRun({ nativeSessionId: 'native-1' })] }),
      states: [monitorState({ statusSince: iso(T0 - HOUR) })],
      history,
    });
    await t.backend.ready;
    const [row] = t.rows();
    expect(row).toMatchObject({ id: 'run-1', statusSince: T0 - HOUR });
    const past = await t.backend.readPast(WINDOW);
    expect(history.asks).toEqual([{ window: WINDOW, silenceMs: PAST_SILENCE_MS }]);
    expect(past.live).toEqual([
      {
        id: 'run-1',
        seamAt: T0 - HOUR,
        spans: [
          { kind: 'worked', from: T0 - 3 * HOUR, to: T0 - 2 * HOUR },
          { kind: 'quiet', from: T0 - 2 * HOUR, to: T0 - HOUR },
        ],
      },
    ]);
    expect(past.ended.map((lane) => lane.id)).toEqual(['past:claude:native-gone']);
    expect(Object.isFrozen(past)).toBe(true);
  });

  it('joins by the runtime’s own native id when the host has none', async () => {
    const t = testBackend({
      facts: facts({ runs: [hostRun()] }),
      states: [monitorState({ statusSince: iso(T0 - HOUR), session: { nativeSessionId: 'native-1' } })],
      history: fakeHistory({
        fidelity: 'turns',
        partial: false,
        sessions: [session({ lastAt: T0, turns: [{ firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR }] })],
      }),
    });
    await t.backend.ready;
    t.rows();
    const past = await t.backend.readPast(WINDOW);
    expect(past.live.map((lane) => lane.id)).toEqual(['run-1']);
    expect(past.ended).toEqual([]);
  });

  it('answers unavailable, in words, with no port and when the port refuses; it never rejects', async () => {
    const none = testBackend({});
    await none.backend.ready;
    await expect(none.backend.readPast(WINDOW)).resolves.toMatchObject({
      state: 'unavailable',
      detail: 'No record of past runs here',
      live: [],
      ended: [],
    });
    const refused = testBackend({ history: fakeHistory(new Error('The agent index is starting')) });
    await refused.backend.ready;
    await expect(refused.backend.readPast(WINDOW)).resolves.toMatchObject({
      state: 'unavailable',
      detail: 'The agent index is starting',
    });
  });

  it('asks the record for at most a day, ending where the ask ends', async () => {
    const history = fakeHistory({ fidelity: 'bounds', partial: false, sessions: [] });
    const t = testBackend({ history });
    await t.backend.ready;
    const past = await t.backend.readPast({ sinceMs: T0 - 3 * PAST_MAX_WINDOW_MS, untilMs: T0 });
    expect(history.asks).toEqual([
      { window: { sinceMs: T0 - PAST_MAX_WINDOW_MS, untilMs: T0 }, silenceMs: PAST_SILENCE_MS },
    ]);
    expect([past.sinceMs, past.untilMs, past.state]).toEqual([T0 - PAST_MAX_WINDOW_MS, T0, 'complete']);
  });
});
