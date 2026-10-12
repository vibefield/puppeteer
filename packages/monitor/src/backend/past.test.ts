import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MonitorPastSnapshot, MonitorPastSpanKind } from '@vibefield/puppeteer-view-sdk/model';
import { createMemoryProjectIdentityStore } from './identity.js';
import {
  clampPastWindow,
  derivePast,
  PAST_MAX_WINDOW_MS,
  PAST_SILENCE_MS,
  spansFromTurns,
  type DerivePastInput,
} from './past.js';
import type {
  MonitorCommand,
  MonitorCommandSink,
  MonitorHistoryPort,
  MonitorRecordedActivity,
  MonitorRecordedRun,
  MonitorRecordedSession,
} from './ports.js';
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
    activity: { fidelity: 'turns', partial: false, sessions: [], runs: [] },
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

/** One of the host's runs: what makes a session a lane once the model no longer holds it. */
function ran(overrides: Partial<MonitorRecordedRun> = {}): MonitorRecordedRun {
  return {
    provider: CLAUDE,
    nativeSessionId: 'native-1',
    runtimeRunId: 'run-1',
    createdAt: T0 - 3 * HOUR - MIN,
    projectKey: '/Users/me/code/billing-api',
    ...overrides,
  };
}

/** A record answer: these sessions, and the host's runs for the named native ids. */
function recorded(
  sessions: readonly MonitorRecordedSession[],
  extra: Partial<MonitorRecordedActivity> = {},
  ranIds: readonly string[] = sessions.map((s) => s.nativeSessionId),
): MonitorRecordedActivity {
  return {
    fidelity: 'turns',
    partial: false,
    sessions,
    runs: ranIds.map((nativeSessionId) => ran({ nativeSessionId, runtimeRunId: `run-${nativeSessionId}` })),
    ...extra,
  };
}

describe('derivePast', () => {
  it('the floor: an ended run is ONE bounds span from its first to its last activity', () => {
    const identity = createMemoryProjectIdentityStore([['/Users/me/code/billing-api', 4]]);
    const past = derivePast(input({ identity, activity: recorded([session()], { fidelity: 'bounds' }) }));
    expect(past.fidelity).toBe('bounds');
    expect(past.live).toEqual([]);
    expect(past.ended).toEqual([
      {
        id: 'past:claude:native-1',
        provider: CLAUDE,
        project: { name: 'billing-api', seq: 4 },
        device: DEVICE,
        startedAt: T0 - 3 * HOUR - MIN,
        endedAt: T0 - 2 * HOUR,
        spans: [{ kind: 'bounds', from: T0 - 3 * HOUR, to: T0 - 2 * HOUR }],
      },
    ]);
  });

  it('ONLY THIS RUNTIME’S RUNS: a session the record holds that this runtime never ran is no lane, live or ended', () => {
    // red-proof of v2 item 7: an agent started in another terminal app, running right now
    const elsewhere = session({ nativeSessionId: 'terminal-app', firstAt: T0 - HOUR, lastAt: T0 });
    const ours = session({ nativeSessionId: 'ours', turns: [{ firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR }] });
    const past = derivePast(input({ activity: recorded([elsewhere, ours], {}, ['ours']) }));
    expect(past.ended.map((lane) => lane.id)).toEqual(['past:claude:ours']);
    expect(past.live).toEqual([]);
    // the same record with no run of ours for either: nothing at all
    expect(derivePast(input({ activity: recorded([elsewhere, ours], {}, []) })).ended).toEqual([]);
  });

  it('reads colour, never deals it: an ended lane writes no project identity', () => {
    const identity = createMemoryProjectIdentityStore([['/Users/me/code/vibe-field', 2]]);
    const past = derivePast(
      input({
        identity,
        activity: {
          ...recorded([session({ nativeSessionId: 'a' }), session({ nativeSessionId: 'b' })], { fidelity: 'bounds' }),
          runs: [
            ran({ nativeSessionId: 'a', projectKey: '/Users/me/code/vibe-field' }),
            // a key never dealt (folded under another spelling): the neutral ramp, and still nothing written
            ran({ nativeSessionId: 'b', projectKey: '/Users/me/code/never-dealt' }),
          ],
        },
      }),
    );
    expect(past.ended.map((lane) => lane.project)).toEqual([{ name: 'vibe-field', seq: 2 }, { name: 'never-dealt' }]);
    expect([...identity.entries()]).toEqual([['/Users/me/code/vibe-field', 2]]);
    expect(identity.next()).toBe(3);
  });

  it('carries the run’s title (else the record’s) and its profile set for the window’s filters', () => {
    const past = derivePast(
      input({
        activity: {
          ...recorded([
            session({ nativeSessionId: 'a', title: 'record title' }),
            session({ nativeSessionId: 'b', title: 'record title' }),
          ]),
          runs: [
            ran({ nativeSessionId: 'a', title: 'Split the invoice writer', profileSet: 'work' }),
            ran({ nativeSessionId: 'b' }),
          ],
        },
      }),
    );
    expect(past.ended.map((lane) => [lane.title, lane.profileSet])).toEqual([
      ['Split the invoice writer', 'work'],
      ['record title', undefined],
    ]);
  });

  it('the floor keeps a live row’s past unrecorded: no live past from bounds alone', () => {
    const past = derivePast(
      input({
        activity: recorded([session({ lastAt: T0 })], { fidelity: 'bounds' }),
        live: [{ id: 'pty-1', providerId: 'claude', nativeSessionId: 'native-1', statusSince: T0 - 10 * MIN }],
      }),
    );
    expect(past.live).toEqual([]);
    expect(past.ended).toEqual([]);
  });

  it('joins a live row by provider and native id and gives its past up to the seam at statusSince', () => {
    const one = session({
      lastAt: T0,
      turns: [
        { firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR },
        { firstAt: T0 - 30 * MIN, lastAt: T0 },
      ],
    });
    const past = derivePast(
      input({
        // the model's row is this runtime's by definition: no run record is needed to join it
        activity: recorded([one], {}, []),
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

  it('a session whose turns a turns snapshot lacks is one flat bounds span', () => {
    const past = derivePast(input({ activity: recorded([session()]) }));
    expect(past.fidelity).toBe('turns');
    expect(past.ended[0]?.spans).toEqual([{ kind: 'bounds', from: T0 - 3 * HOUR, to: T0 - 2 * HOUR }]);
  });

  it('never joins across providers: the same native id under another provider is its own lane, if ours', () => {
    const codex = { id: 'codex', label: 'Codex' };
    const past = derivePast(
      input({
        activity: {
          ...recorded([session({ provider: codex, turns: [] })], {}, []),
          runs: [ran({ provider: codex })],
        },
        live: [{ id: 'pty-1', providerId: 'claude', nativeSessionId: 'native-1', statusSince: T0 }],
      }),
    );
    expect(past.live).toEqual([]);
    expect(past.ended.map((lane) => lane.id)).toEqual(['past:codex:native-1']);
  });

  it('orders ended lanes by birth and says partial when the record did', () => {
    const past = derivePast(
      input({
        activity: recorded(
          [
            session({ nativeSessionId: 'late', startedAt: T0 - HOUR, firstAt: T0 - HOUR, lastAt: T0 - 30 * MIN }),
            session({ nativeSessionId: 'early' }),
          ],
          { fidelity: 'bounds', partial: true, detail: 'The agent index has not read every session yet' },
        ),
      }),
    );
    expect(past.state).toBe('partial');
    expect(past.detail).toBe('The agent index has not read every session yet');
    expect(past.ended.map((lane) => lane.id)).toEqual(['past:claude:early', 'past:claude:late']);
  });

  it('leaves out a session whose activity misses the window, and never names blocked or unseen', () => {
    const past = derivePast(
      input({
        activity: recorded([
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
        ]),
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
  it('joins the record with the model as it is: the row’s id, its statusSince as the seam, our ended run beside it', async () => {
    const history = fakeHistory(
      recorded(
        [
          session({ lastAt: T0, turns: [{ firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR }] }),
          session({ nativeSessionId: 'native-gone', turns: [{ firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR }] }),
          session({ nativeSessionId: 'never-ours', turns: [{ firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR }] }),
        ],
        {},
        ['native-gone'],
      ),
    );
    const t = testBackend({
      facts: facts({ runs: [hostRun({ nativeSessionId: 'native-1' })] }),
      states: [monitorState({ statusSince: iso(T0 - HOUR) })],
      history,
    });
    await t.backend.ready;
    const [row] = t.rows();
    expect(row).toMatchObject({ id: 'run-1', statusSince: T0 - HOUR });
    const past = (await t.backend.readPast(WINDOW))!;
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
      history: fakeHistory(
        recorded([session({ lastAt: T0, turns: [{ firstAt: T0 - 3 * HOUR, lastAt: T0 - 2 * HOUR }] })]),
      ),
    });
    await t.backend.ready;
    t.rows();
    const past = (await t.backend.readPast(WINDOW))!;
    expect(past.live.map((lane) => lane.id)).toEqual(['run-1']);
    expect(past.ended).toEqual([]);
  });

  it('with no port there is no past to lend; a port that refuses answers unavailable at once, in words', async () => {
    const none = testBackend({});
    await none.backend.ready;
    await expect(none.backend.readPast(WINDOW)).resolves.toBeUndefined();
    const refused = testBackend({ history: fakeHistory(new Error('The agent index is starting')) });
    await refused.backend.ready;
    await expect(refused.backend.readPast(WINDOW)).resolves.toMatchObject({
      state: 'unavailable',
      detail: 'The agent index is starting',
      live: [],
      ended: [],
    });
  });

  it('asks the record for at most a day, ending where the ask ends', async () => {
    const history = fakeHistory(recorded([], { fidelity: 'bounds' }));
    const t = testBackend({ history });
    await t.backend.ready;
    const past = (await t.backend.readPast({ sinceMs: T0 - 3 * PAST_MAX_WINDOW_MS, untilMs: T0 }))!;
    expect(history.asks).toEqual([
      { window: { sinceMs: T0 - PAST_MAX_WINDOW_MS, untilMs: T0 }, silenceMs: PAST_SILENCE_MS },
    ]);
    expect([past.sinceMs, past.untilMs, past.state]).toEqual([T0 - PAST_MAX_WINDOW_MS, T0, 'complete']);
  });

  it('an ended lane is never opened here: its past: id is no command the backend routes, and none opens one', async () => {
    const t = testBackend({
      history: fakeHistory(recorded([session({ nativeSessionId: 'native-gone' })])),
    });
    await t.backend.ready;
    const past = (await t.backend.readPast(WINDOW))!;
    const [lane] = past.ended;
    expect(lane?.id).toBe('past:claude:native-gone');
    expect(t.backend.command({ type: 'select', id: lane!.id })).toBe(false);
    expect(t.backend.command({ type: 'acknowledge', id: lane!.id })).toBe(false);
    expect([t.sink.selected, t.sink.created]).toEqual([[], []]);
    // TV-8: a view's `openEnded` is its HOST's to answer. The backend's commands and its sink stay the ones they were.
    expectTypeOf<MonitorCommand['type']>().toEqualTypeOf<'select' | 'create' | 'acknowledge'>();
    expectTypeOf<keyof MonitorCommandSink>().toEqualTypeOf<'select' | 'create'>();
  });
});
