import { describe, expect, it } from 'vitest';
import { createMonitorReplica } from '../replica/replica.js';
import { DEFAULT_MONITOR_SEAL_CAPACITY } from '../store.js';
import { createMonitorBackend } from './backend.js';
import { createMemoryProjectIdentityStore } from './identity.js';
import {
  DEVICE,
  T0,
  facts,
  fakeHost,
  fakeRunSource,
  hostRun,
  hostTerminal,
  iso,
  manualClock,
  manualScheduler,
  monitorState,
  recordingSink,
  testBackend,
} from './testing/fixtures.js';
import { EMPTY_UNREAD_LEDGER, reconcileUnread } from './unread.js';

describe('the join', () => {
  it('shows a run the host names before the runtime has spoken, as starting', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }) });
    await t.backend.ready;
    expect(t.rows()).toMatchObject([
      { id: 'run-1', kind: 'agent', status: 'working', detail: 'starting', alive: true },
    ]);
  });

  it('shows no row for a state the host has not named', async () => {
    const t = testBackend({ states: [monitorState()] });
    await t.backend.ready;
    expect(t.rows()).toEqual([]);
    t.host.update({ runs: [hostRun()] });
    expect(t.rows()).toMatchObject([{ id: 'run-1', detail: 'Edit · src/app.ts' }]);
  });

  it('drops a run the runtime removed even while the host still names it, until a newer epoch revives it', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [monitorState()] });
    await t.backend.ready;
    expect(t.rows()).toHaveLength(1);
    t.source.remove({ runtimeRunId: 'run-1', runtimeEpoch: 1 });
    expect(t.backend.getSnapshot().rows).toEqual([]);
    t.source.push(monitorState({ runtimeEpoch: 1, revision: 9 }));
    expect(t.rows()).toEqual([]);
    t.source.push(monitorState({ runtimeEpoch: 2, revision: 1, status: 'idle', activity: undefined }));
    expect(t.rows()).toMatchObject([{ id: 'run-1', status: 'idle' }]);
  });

  it('keeps a removed run hidden when the host drops it and names it again, while its seal is within the cap (M25)', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [monitorState()] });
    await t.backend.ready;
    expect(t.rows()).toHaveLength(1);
    t.source.remove({ runtimeRunId: 'run-1', runtimeEpoch: 1 });
    expect(t.rows()).toEqual([]);
    t.host.update({ runs: [] });
    expect(t.rows()).toEqual([]);
    // One record of removals, the store's: a host naming the run again does not bring it back, as today…
    t.host.update({ runs: [hostRun()] });
    expect(t.rows()).toEqual([]);
    // …nor does the removed epoch's late state; a newer epoch revives it.
    t.source.push(monitorState({ runtimeEpoch: 1, revision: 9, status: 'idle', activity: undefined }));
    expect(t.rows()).toEqual([]);
    t.source.push(monitorState({ runtimeEpoch: 2, revision: 1, status: 'idle', activity: undefined }));
    expect(t.rows()).toMatchObject([{ id: 'run-1', observed: true, status: 'idle' }]);
  });

  it('past the store’s cap a removal is forgotten: a run named again then reads as starting (drop a run only for good)', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [monitorState()] });
    await t.backend.ready;
    t.rows();
    t.source.remove({ runtimeRunId: 'run-1', runtimeEpoch: 1 });
    t.host.update({ runs: [] });
    expect(t.rows()).toEqual([]);
    for (let index = 0; index < DEFAULT_MONITOR_SEAL_CAPACITY; index += 1) {
      t.source.remove({ runtimeRunId: `gone-${index}`, runtimeEpoch: 1 });
    }
    t.host.update({ runs: [hostRun()] });
    expect(t.rows()).toMatchObject([{ id: 'run-1', observed: false, detail: 'starting' }]);
  });

  it('merges the listing under live pushes: a newer push is not overwritten by an older listing', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), deferList: true });
    t.source.push(monitorState({ revision: 5, status: 'blocked', blockers: [], activity: undefined }));
    t.source.list([monitorState({ revision: 2 })]);
    await t.backend.ready;
    expect(t.rows()).toMatchObject([{ status: 'blocked' }]);
  });

  it('carries the device, tier, account and profile set the host gives', async () => {
    const t = testBackend({
      facts: facts({
        runs: [hostRun({ tier: 'managed', account: 'me@work', profileId: 'p-1' })],
        profileSets: [
          {
            id: 'work',
            label: 'Work',
            kind: 'managed',
            personas: [{ profileId: 'p-1', providerLabel: 'Claude Code' }],
          },
        ],
      }),
    });
    await t.backend.ready;
    expect(t.rows()).toMatchObject([{ device: DEVICE, tier: 'managed', account: 'me@work', profileSet: 'work' }]);
  });
});

describe('identity carry-forward and dedupe', () => {
  it('lets a run promoted from a shell keep the shell row’s id, and the shell row goes', async () => {
    const t = testBackend({ facts: facts({ terminals: [hostTerminal({ sessionId: 'pty-1' })] }) });
    await t.backend.ready;
    expect(t.rows()).toMatchObject([{ id: 'pty-1', kind: 'terminal' }]);
    t.host.update({ runs: [hostRun({ terminalSessionId: 'pty-1' })] });
    expect(t.rows()).toMatchObject([{ id: 'pty-1', kind: 'agent' }]);
    expect(t.changes.at(-1)).toMatchObject({ upserts: [{ id: 'pty-1', kind: 'agent' }], removed: [] });
  });

  it('keeps the id when the shell left the list in the same tick the run arrived', async () => {
    const t = testBackend({ facts: facts({ terminals: [hostTerminal({ sessionId: 'pty-1' })] }) });
    await t.backend.ready;
    t.rows();
    t.host.set(facts({ runs: [hostRun({ terminalSessionId: 'pty-1' })] }));
    expect(t.rows()).toMatchObject([{ id: 'pty-1', kind: 'agent' }]);
  });

  it('uses the host’s terminal identity across PTY handoffs', async () => {
    const t = testBackend({
      facts: facts({ runs: [hostRun({ terminalSessionId: 'pty-2', terminalIdentity: 'stable-1' })] }),
    });
    await t.backend.ready;
    expect(t.rows()).toMatchObject([{ id: 'stable-1' }]);
    expect(
      testBackend({ facts: facts({ terminals: [hostTerminal({ sessionId: 'pty-3', identity: 'stable-2' })] }) }).rows(),
    ).toMatchObject([{ id: 'stable-2' }]);
  });

  it('keeps a resumed run’s id through a new epoch and a new PTY, and claims the PTY it replaced', async () => {
    const t = testBackend({
      facts: facts({
        runs: [hostRun({ terminalSessionId: 'pty-1' })],
        terminals: [hostTerminal({ sessionId: 'pty-1' })],
      }),
      states: [monitorState()],
    });
    await t.backend.ready;
    const [before] = t.rows();
    expect(before?.id).toBe('pty-1');
    t.host.set(
      facts({
        runs: [hostRun({ terminalSessionId: 'pty-2', replacedTerminalSessionId: 'pty-1' })],
        terminals: [hostTerminal({ sessionId: 'pty-1' }), hostTerminal({ sessionId: 'pty-2' })],
      }),
    );
    t.source.push(monitorState({ runtimeEpoch: 2, revision: 1 }));
    const rows = t.rows();
    expect(rows.map((row) => [row.id, row.kind])).toEqual([['pty-1', 'agent']]);
  });

  it('never holds one id in two rows: a second run in the same shell falls back to its run id', async () => {
    const t = testBackend({ facts: facts({ terminals: [hostTerminal({ sessionId: 'pty-1' })] }) });
    await t.backend.ready;
    t.rows();
    t.host.update({ runs: [hostRun({ runtimeRunId: 'run-a', terminalSessionId: 'pty-1', alive: false })] });
    expect(t.rows().map((row) => row.id)).toEqual(['pty-1']);
    t.host.update({
      runs: [
        hostRun({ runtimeRunId: 'run-a', terminalSessionId: 'pty-1', alive: false }),
        hostRun({ runtimeRunId: 'run-b', terminalSessionId: 'pty-1', createdAt: T0 }),
      ],
    });
    expect(t.rows().map((row) => row.id)).toEqual(['pty-1', 'run-b']);
  });

  it('drops a duplicate terminal identity and a terminal whose session an agent speaks for', async () => {
    const t = testBackend({
      facts: facts({
        runs: [hostRun({ terminalSessionId: 'pty-1' })],
        terminals: [
          hostTerminal({ sessionId: 'pty-1' }),
          hostTerminal({ sessionId: 'pty-2', identity: 'same' }),
          hostTerminal({ sessionId: 'pty-3', identity: 'same' }),
          hostTerminal({ sessionId: 'pty-4', exited: true }),
        ],
      }),
    });
    await t.backend.ready;
    expect(t.rows().map((row) => row.id)).toEqual(['pty-1', 'same']);
  });

  it('the host contract: a PTY kept listed until its run is named carries its id through any tick between (mv-review)', async () => {
    for (const keepsListed of [true, false]) {
      const t = testBackend({
        facts: facts({ terminals: [hostTerminal({ sessionId: 'pty-1', identity: 'shell-A', cwd: '/w' })] }),
      });
      await t.backend.ready;
      expect(t.rows()).toMatchObject([{ id: 'shell-A', kind: 'terminal' }]);
      const before = t.changes.length;
      // The PTY is an agent's now. A host that breaks the contract drops it from its roster first…
      if (!keepsListed) t.host.update({ terminals: [] });
      // …and any tick lands before the run is named: here the 10 s recency clock.
      t.clock.advance(10_000);
      t.scheduler.flush();
      t.host.update({ runs: [hostRun({ runtimeRunId: 'run-1', terminalSessionId: 'pty-1' })] });
      t.scheduler.flush();
      // Once the run is named the terminal may go.
      t.host.update({ terminals: [] });
      t.scheduler.flush();
      const tail = t.changes.slice(before).map((change) => ({
        upserts: change.upserts.map((row) => `${row.kind}:${row.id}`),
        removed: [...change.removed],
      }));
      expect(tail).toEqual(
        keepsListed
          ? [{ upserts: ['agent:shell-A'], removed: [] }]
          : // what a view sees then: the shell's body removed, a different body added (the one-tick memory cannot
            // bridge it)
            [
              { upserts: [], removed: ['shell-A'] },
              { upserts: ['agent:run-1'], removed: [] },
            ],
      );
    }
  });

  it('says which row a run is with idOf: the shell’s id after a promotion, the run’s own otherwise (mv3a’s ask)', async () => {
    const t = testBackend({
      facts: facts({ terminals: [hostTerminal({ sessionId: 'pty-1', identity: 'shell-A', cwd: '/w' })] }),
    });
    await t.backend.ready;
    expect(t.rows()).toMatchObject([{ id: 'shell-A', kind: 'terminal' }]);
    expect(t.backend.idOf('run-1')).toBeUndefined();
    // the host names the run in that PTY, keeping the terminal listed until then (the host contract)
    t.host.update({
      runs: [
        hostRun({ runtimeRunId: 'run-1', terminalSessionId: 'pty-1' }),
        hostRun({ runtimeRunId: 'run-2', terminalSessionId: 'pty-2', createdAt: T0 }),
      ],
    });
    expect(t.rows().map((row) => [row.id, row.kind])).toEqual([
      ['shell-A', 'agent'],
      ['run-2', 'agent'],
    ]);
    expect(t.backend.idOf('run-1')).toBe('shell-A');
    expect(t.backend.idOf('run-2')).toBe('run-2');
    // the id survives a new epoch in a new PTY (AR-4)
    t.host.update({
      runs: [
        hostRun({ runtimeRunId: 'run-1', terminalSessionId: 'pty-3', replacedTerminalSessionId: 'pty-1' }),
        hostRun({ runtimeRunId: 'run-2', terminalSessionId: 'pty-2', createdAt: T0 }),
      ],
      terminals: [],
    });
    t.source.push(monitorState({ runtimeEpoch: 2, revision: 1 }));
    t.rows();
    expect(t.backend.idOf('run-1')).toBe('shell-A');
    // a run with no row has no id: removed by the runtime, unknown, or after dispose
    t.source.remove({ runtimeRunId: 'run-1', runtimeEpoch: 2 });
    expect(t.backend.getSnapshot().rows.map((row) => row.id)).toEqual(['run-2']);
    expect(t.backend.idOf('run-1')).toBeUndefined();
    expect(t.backend.idOf('nobody')).toBeUndefined();
    t.backend.dispose();
    expect(t.backend.idOf('run-2')).toBeUndefined();
  });
});

describe('order and recency', () => {
  it('orders agents by birth, then terminals, ties by id', async () => {
    const t = testBackend({
      facts: facts({
        runs: [
          hostRun({ runtimeRunId: 'late', createdAt: T0 + 2, terminalSessionId: 'p-l' }),
          hostRun({ runtimeRunId: 'early', createdAt: T0 + 1, terminalSessionId: 'p-e' }),
          hostRun({ runtimeRunId: 'b', createdAt: T0 + 1, terminalSessionId: 'p-b' }),
        ],
        terminals: [hostTerminal({ sessionId: 'z', createdAt: 0 }), hostTerminal({ sessionId: 'a', createdAt: T0 })],
      }),
    });
    await t.backend.ready;
    expect(t.rows().map((row) => row.id)).toEqual(['b', 'early', 'late', 'z', 'a']);
  });

  it('re-reads recency on the 10 s clock and rebuilds only the row whose staleness flipped', async () => {
    const t = testBackend({
      facts: facts({
        runs: [
          hostRun({ runtimeRunId: 'fresh', terminalSessionId: 'p1' }),
          hostRun({ runtimeRunId: 'old', terminalSessionId: 'p2' }),
        ],
      }),
      states: [
        monitorState({
          runtimeRunId: 'fresh',
          freshness: { level: 'native-hooks', families: {}, lastEvidenceAt: iso(T0) },
        }),
        monitorState({
          runtimeRunId: 'old',
          freshness: { level: 'native-hooks', families: {}, lastEvidenceAt: iso(T0 - 25_000) },
        }),
      ],
    });
    await t.backend.ready;
    const [fresh, old] = t.rows();
    expect([fresh?.stale, old?.stale]).toEqual([false, false]);
    t.clock.advance(10_000);
    const after = t.rows();
    expect(after.map((row) => row.stale)).toEqual([false, true]);
    expect(after[0]).toBe(fresh);
    expect(after[1]).not.toBe(old);
    expect(t.changes.at(-1)?.upserts.map((row) => row.id)).toEqual(['old']);
    const revision = t.backend.getSnapshot().revision;
    t.clock.advance(10_000);
    t.scheduler.flush();
    expect(t.backend.getSnapshot().revision).toBe(revision);
  });

  it('dates a terminal’s status from its birth and from the moment it flips', async () => {
    const t = testBackend({ facts: facts({ terminals: [hostTerminal({ sessionId: 'p', createdAt: T0 - 5 })] }) });
    await t.backend.ready;
    expect(t.rows()[0]?.statusSince).toBe(T0 - 5);
    t.clock.advance(1_000);
    t.host.update({
      terminals: [hostTerminal({ sessionId: 'p', createdAt: T0 - 5, activity: { kind: 'foreground-job' } })],
    });
    expect(t.rows()[0]).toMatchObject({ status: 'working', statusSince: T0 + 1_000 });
  });
});

describe('cost', () => {
  const priced = (overrides: Partial<ReturnType<typeof monitorState>> = {}) =>
    monitorState({
      usage: {
        samples: [],
        costUsd: 1.25,
        costCoverage: 'complete',
        costRatePerMin: 0.1,
        costHistory: [
          { at: iso(T0 - 30_000), costUsd: 0.75 },
          { at: iso(T0), costUsd: 0.5 },
        ],
      },
      session: { nativeSessionId: 'native-1' },
      ...overrides,
    });

  it("carries the ledger's total, coverage, burn an hour and the 20-step series aligned to the boundary", async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [priced()] });
    await t.backend.ready;
    const [row] = t.rows();
    expect(row?.cost).toEqual({
      usd: 1.25,
      coverage: 'complete',
      burnPerHour: 6,
      series: { stepMs: 30_000, steps: [...new Array<number>(18).fill(0), 0.75, 0.5], lastStepAt: T0 },
    });
    expect(Object.isFrozen(row?.cost)).toBe(true);
  });

  it('has no cost until something is priced, and a terminal never has one', async () => {
    const t = testBackend({
      facts: facts({ runs: [hostRun()], terminals: [hostTerminal()] }),
      states: [monitorState({ usage: { samples: [], cumulativeTokens: 500 } })],
    });
    await t.backend.ready;
    const rows = t.rows();
    expect(rows.map((row) => row.cost)).toEqual([undefined, undefined]);
    expect(rows[0]?.tokens).toEqual({ total: 500 });
  });

  it('steps the series on the 30 s boundary and re-emits only the priced rows', async () => {
    const t = testBackend({
      facts: facts({
        runs: [
          hostRun({ runtimeRunId: 'paid', terminalSessionId: 'p1' }),
          hostRun({ runtimeRunId: 'free', terminalSessionId: 'p2' }),
        ],
      }),
      states: [priced({ runtimeRunId: 'paid' }), monitorState({ runtimeRunId: 'free' })],
    });
    await t.backend.ready;
    const before = new Map(t.rows().map((row) => [row.id, row]));
    const revision = t.backend.getSnapshot().revision;
    t.scheduler.flush();
    expect(t.backend.getSnapshot().revision).toBe(revision);
    t.clock.advance(30_000);
    const after = new Map(t.rows().map((row) => [row.id, row]));
    expect(after.get('free')).toBe(before.get('free'));
    expect(after.get('paid')).not.toBe(before.get('paid'));
    expect(after.get('paid')?.cost?.series).toEqual({
      stepMs: 30_000,
      steps: [...new Array<number>(17).fill(0), 0.75, 0.5, 0],
      lastStepAt: T0 + 30_000,
    });
    expect(t.changes.at(-1)?.upserts.map((row) => row.id)).toEqual(['paid']);
  });

  it('accumulates a resumed epoch of the same conversation and resets for a different one', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [priced()] });
    await t.backend.ready;
    expect(t.rows()[0]?.cost?.usd).toBe(1.25);
    t.source.push(
      priced({
        runtimeEpoch: 2,
        usage: { samples: [], costUsd: 0.5, costCoverage: 'complete', costHistory: [{ at: iso(T0), costUsd: 0.5 }] },
      }),
    );
    expect(t.rows()[0]?.cost).toMatchObject({ usd: 1.75, coverage: 'complete' });
    expect(t.rows()[0]?.cost?.burnPerHour).toBeUndefined();
    t.source.push(
      priced({
        runtimeEpoch: 3,
        session: { nativeSessionId: 'native-2' },
        usage: { samples: [], costUsd: 0.25, costCoverage: 'partial', costHistory: [] },
      }),
    );
    expect(t.rows()[0]?.cost).toMatchObject({ usd: 0.25, coverage: 'partial' });
  });

  it('forgets the ledger with the run', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [priced()] });
    await t.backend.ready;
    expect(t.rows()[0]?.cost?.usd).toBe(1.25);
    t.source.remove({ runtimeRunId: 'run-1', runtimeEpoch: 1 });
    t.host.update({ runs: [] });
    expect(t.rows()).toEqual([]);
    t.host.update({ runs: [hostRun()] });
    t.source.push(
      priced({ runtimeEpoch: 2, usage: { samples: [], costUsd: 0.1, costCoverage: 'complete', costHistory: [] } }),
    );
    expect(t.rows()[0]?.cost?.usd).toBe(0.1);
  });
});

describe('unread (L5)', () => {
  // The store takes only a newer revision per run, so every state the helpers make is newer than the last.
  let rev = 0;
  const working = (id: string, since: number) =>
    monitorState({ runtimeRunId: id, revision: ++rev, status: 'working', statusSince: iso(since) });
  const idle = (id: string, since: number) =>
    monitorState({ runtimeRunId: id, revision: ++rev, status: 'idle', statusSince: iso(since), activity: undefined });
  const two = () =>
    testBackend({
      facts: facts({
        runs: [
          hostRun({ runtimeRunId: 'a', terminalSessionId: 'pa' }),
          hostRun({ runtimeRunId: 'b', terminalSessionId: 'pb' }),
        ],
      }),
      states: [working('a', T0 - 10_000), working('b', T0 - 10_000)],
    });
  const unreadIds = (t: ReturnType<typeof testBackend>) =>
    t
      .rows()
      .filter((row) => row.unread)
      .map((row) => row.id);

  it('marks a turn that finishes while no screen shows the row, and clears it when any screen does', async () => {
    const t = two();
    await t.backend.ready;
    // a screen is open, its active pane showing nothing (M20: a screen counts from its first report)
    t.backend.reportShown('window-1', []);
    expect(unreadIds(t)).toEqual([]);
    t.clock.advance(5_000);
    t.source.push(idle('a', T0 + 4_000));
    expect(unreadIds(t)).toEqual(['a']);
    expect(t.changes.at(-1)?.upserts.map((row) => [row.id, row.unread])).toEqual([['a', true]]);
    t.backend.reportShown('window-1', ['a']);
    expect(unreadIds(t)).toEqual([]);
    t.backend.reportShown('window-1', []);
    expect(unreadIds(t)).toEqual([]);
  });

  it('never marks a row a screen is showing when its turn ends, even while another screen is not', async () => {
    const t = two();
    await t.backend.ready;
    t.backend.reportShown('window-1', ['b']);
    t.backend.reportShown('window-2', ['a']);
    t.clock.advance(5_000);
    t.source.push(idle('a', T0 + 4_000));
    expect(unreadIds(t)).toEqual([]);
    t.backend.reportShown('window-2', []);
    t.clock.advance(5_000);
    t.source.push(idle('a', T0 + 9_000));
    t.source.push(working('a', T0 + 9_500));
    t.source.push(idle('a', T0 + 9_800));
    expect(unreadIds(t)).toEqual(['a']);
    t.backend.reportShown('phone', ['a']);
    expect(unreadIds(t)).toEqual([]);
  });

  it('does not mark a turn that began and ended between two ticks when a screen showed it, but does when none did', async () => {
    const t = two();
    await t.backend.ready;
    t.backend.reportShown('window-1', ['a']);
    t.clock.advance(5_000);
    t.source.push(idle('a', T0 + 2_000));
    t.source.push(idle('b', T0 + 2_000));
    expect(unreadIds(t)).toEqual(['b']);
  });

  it('never marks a bare terminal, and a report of an unchanged set emits nothing', async () => {
    const t = testBackend({
      facts: facts({ terminals: [hostTerminal({ sessionId: 'sh', activity: { kind: 'foreground-job' } })] }),
    });
    await t.backend.ready;
    t.rows();
    t.clock.advance(5_000);
    t.host.update({ terminals: [hostTerminal({ sessionId: 'sh' })] });
    expect(t.rows().map((row) => [row.status, row.unread])).toEqual([['idle', false]]);
    const revision = t.backend.getSnapshot().revision;
    t.backend.reportShown('window-1', []);
    t.backend.reportShown('window-1', ['nobody']);
    t.backend.reportShown('window-1', ['nobody']);
    expect(t.backend.getSnapshot().revision).toBe(revision);
  });

  it('is exactly the single-window fold: one screen reporting its active row replays the ledger', async () => {
    // The scripted day: (seconds, which row is active, each run's status and when it began).
    const script: Array<[number, string | undefined, Record<string, ['idle' | 'working', number]>]> = [
      [0, 'a', { a: ['working', -60], b: ['working', -60] }],
      [10, 'a', { a: ['working', -60], b: ['idle', 8] }],
      [20, 'b', { a: ['idle', 15], b: ['idle', 8] }],
      [30, 'b', { a: ['idle', 15], b: ['idle', 25] }],
      [40, undefined, { a: ['idle', 35], b: ['working', 38] }],
      [50, 'a', { a: ['idle', 35], b: ['idle', 48] }],
    ];
    const t = testBackend({
      facts: facts({
        runs: [
          hostRun({ runtimeRunId: 'a', terminalSessionId: 'pa' }),
          hostRun({ runtimeRunId: 'b', terminalSessionId: 'pb' }),
        ],
      }),
      deferList: true,
    });
    let expected = EMPTY_UNREAD_LEDGER;
    let revision = 0;
    for (const [seconds, active, runs] of script) {
      t.clock.advance(T0 + seconds * 1000 - t.clock.now());
      t.backend.reportShown('window', active === undefined ? [] : [active]);
      for (const [id, [status, since]] of Object.entries(runs)) {
        revision += 1;
        t.source.push(
          monitorState({
            runtimeRunId: id,
            revision,
            status,
            statusSince: iso(T0 + since * 1000),
            activity: undefined,
          }),
        );
      }
      const rows = t.rows();
      expected = reconcileUnread(
        expected,
        rows.map((row) => ({
          id: row.id,
          status: row.status,
          active: row.id === active,
          hasAgent: true,
          statusSinceMs: row.statusSince,
        })),
        t.clock.now(),
      );
      expect(rows.filter((row) => row.unread).map((row) => row.id)).toEqual([...expected.unreadIds]);
    }
    expect([...expected.unreadIds]).toEqual(['b']);
  });

  describe('lifetime: the ledger outlives every screen (Q05, ruled by James 2026-10-27; M20 before it)', () => {
    it('marks a turn that finished while no screen was open: the screen that opens later finds the mark', async () => {
      for (const opensShowing of [['something-else'], []]) {
        const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [monitorState()] });
        await t.backend.ready;
        t.rows();
        // the turn finishes while Godview is closed
        t.clock.advance(5_000);
        t.source.push(monitorState({ revision: 2, status: 'idle', statusSince: iso(T0 + 5_000), activity: undefined }));
        expect(t.rows()[0]).toMatchObject({ id: 'run-1', status: 'idle', unread: true });
        // Godview opens, its active pane showing another row or nothing: the mark is there
        t.clock.advance(1_000);
        t.backend.reportShown('win-1', opensShowing);
        expect(t.backend.getSnapshot().rows[0]).toMatchObject({ id: 'run-1', unread: true });
        // its pane shows the row: cleared
        t.backend.reportShown('win-1', ['run-1']);
        expect(t.backend.getSnapshot().rows[0]).toMatchObject({ id: 'run-1', unread: false });
      }
    });

    it('sees a row first named while no screen is open at that fold: only a turn that ends after it is marked', async () => {
      const t = testBackend({ facts: facts({ runs: [] }) });
      await t.backend.ready;
      t.rows();
      t.clock.advance(10_000);
      // the run's turn ended before any fold named it
      t.source.push(monitorState({ revision: 1, status: 'idle', statusSince: iso(T0 + 2_000), activity: undefined }));
      t.host.update({ runs: [hostRun()] });
      expect(t.rows()[0]).toMatchObject({ id: 'run-1', status: 'idle', unread: false });
      t.clock.advance(5_000);
      t.source.push(monitorState({ revision: 2, status: 'working', statusSince: iso(T0 + 12_000) }));
      t.source.push(monitorState({ revision: 3, status: 'idle', statusSince: iso(T0 + 14_000), activity: undefined }));
      expect(t.rows()[0]).toMatchObject({ id: 'run-1', unread: true });
    });

    it('forgetting a screen keeps every mark: a reload and a closed Godview find them, and a turn that ends meanwhile is marked', async () => {
      const t = two();
      await t.backend.ready;
      t.backend.reportShown('window-1', ['b']);
      t.backend.reportShown('window-2', []);
      t.clock.advance(5_000);
      t.source.push(idle('a', T0 + 4_000));
      expect(unreadIds(t)).toEqual(['a']);
      // one of two windows closes: the row it showed is shown no more, so its next turn's end is marked
      t.backend.forgetScreen('window-1');
      expect(unreadIds(t)).toEqual(['a']);
      t.clock.advance(1_000);
      t.source.push(idle('b', T0 + 5_500));
      expect(unreadIds(t)).toEqual(['a', 'b']);
      // the last window reloads: its screen is forgotten, the marks stay, and the reloaded window's screen finds them
      const { revision } = t.backend.getSnapshot();
      t.backend.forgetScreen('window-2');
      expect(unreadIds(t)).toEqual(['a', 'b']);
      expect(t.backend.getSnapshot().revision).toBe(revision);
      t.backend.reportShown('window-3', []);
      expect(unreadIds(t)).toEqual(['a', 'b']);
      // its pane shows a, which clears; then Godview closes, and a's next turn ends while no screen is open: marked
      t.backend.reportShown('window-3', ['a']);
      expect(unreadIds(t)).toEqual(['b']);
      t.backend.forgetScreen('window-3');
      t.clock.advance(5_000);
      t.source.push(working('a', T0 + 9_000));
      t.source.push(idle('a', T0 + 9_500));
      expect(unreadIds(t)).toEqual(['a', 'b']);
      // Godview opens again: the marks are there
      t.backend.reportShown('window-4', []);
      expect(unreadIds(t)).toEqual(['a', 'b']);
      // forgetting a screen nobody registered, twice, or after dispose changes nothing
      const after = t.backend.getSnapshot().revision;
      t.backend.forgetScreen('nobody');
      t.backend.forgetScreen('window-1');
      expect(t.backend.getSnapshot().revision).toBe(after);
      t.backend.dispose();
      t.backend.forgetScreen('window-4');
      expect(t.backend.getSnapshot().revision).toBe(after);
    });

    it('a screen that reports an empty list stays open: the single-window fold still runs while its pane shows nothing', async () => {
      const t = two();
      await t.backend.ready;
      t.backend.reportShown('window-1', ['a']);
      t.backend.reportShown('window-1', []);
      t.clock.advance(5_000);
      t.source.push(idle('a', T0 + 4_000));
      expect(unreadIds(t)).toEqual(['a']);
    });

    it('reads the ledger as a copy, and a backend seeded with it keeps the marks across its host’s restart', async () => {
      const first = two();
      await first.backend.ready;
      first.backend.reportShown('window-1', ['a']);
      first.clock.advance(5_000);
      first.backend.reportShown('window-1', ['b']);
      const seen = first.backend.seenAt();
      expect(Object.fromEntries(seen)).toEqual({ a: T0, b: T0 + 5_000 });
      expect(first.backend.seenAt()).not.toBe(seen);
      first.backend.dispose();
      // the host restarts; meanwhile a's turn ended after it was last seen, b's before
      const next = testBackend({
        facts: facts({
          runs: [
            hostRun({ runtimeRunId: 'a', terminalSessionId: 'pa' }),
            hostRun({ runtimeRunId: 'b', terminalSessionId: 'pb' }),
          ],
        }),
        states: [idle('a', T0 + 2_000), idle('b', T0 + 4_000)],
        seenAt: seen,
      });
      // a restart comes later than every stamp it is handed: its first fold, and any after it, find both turns ended
      next.clock.advance(10_000);
      await next.backend.ready;
      expect(unreadIds(next)).toEqual(['a']);
      expect(Object.fromEntries(next.backend.seenAt())).toEqual({ a: T0, b: T0 + 5_000 });
      // unseeded, the same restart would see both rows for the first time and mark neither
      const unseeded = testBackend({
        facts: facts({
          runs: [
            hostRun({ runtimeRunId: 'a', terminalSessionId: 'pa' }),
            hostRun({ runtimeRunId: 'b', terminalSessionId: 'pb' }),
          ],
        }),
        states: [idle('a', T0 + 2_000), idle('b', T0 + 4_000)],
      });
      unseeded.clock.advance(10_000);
      await unseeded.backend.ready;
      expect(unreadIds(unseeded)).toEqual([]);
      // and keeps not marking them: first sight was after both turns ended
      unseeded.clock.advance(10_000);
      expect(unreadIds(unseeded)).toEqual([]);
    });

    it('takes a seed once, at the fold that first names its row; a row that leaves and returns is seen anew', async () => {
      const a = hostRun({ runtimeRunId: 'a', terminalSessionId: 'pa' });
      const late = hostRun({ runtimeRunId: 'late', terminalSessionId: 'pl' });
      const t = testBackend({
        facts: facts({ runs: [a] }),
        states: [idle('a', T0 - 5_000)],
        seenAt: new Map([
          ['a', T0 - 10_000],
          ['late', T0 - 10_000],
        ]),
      });
      await t.backend.ready;
      expect(unreadIds(t)).toEqual(['a']);
      // a seed no fold has taken is not the ledger's yet
      expect([...t.backend.seenAt().keys()]).toEqual(['a']);
      // the row arrives later and takes its seed then: its turn ended after the seeded sight, so it is marked
      t.clock.advance(5_000);
      t.host.update({ runs: [a, late] });
      t.source.push(idle('late', T0 - 1_000));
      expect(unreadIds(t)).toEqual(['a', 'late']);
      // it leaves, and the ledger drops it as it drops any row; named again, it is seen for the first time
      t.host.update({ runs: [a] });
      expect(t.rows().map((row) => row.id)).toEqual(['a']);
      t.clock.advance(1_000);
      t.host.update({ runs: [a, late] });
      expect(unreadIds(t)).toEqual(['a']);
      expect(t.backend.seenAt().get('late')).toBe(T0 + 6_000);
    });
  });
});

describe('identity (L4)', () => {
  it('deals each project a sequence in row order on first sight, shares it within a project, and rides it on the row', async () => {
    const t = testBackend({
      facts: facts({
        runs: [
          hostRun({ runtimeRunId: 'r1', terminalSessionId: 'p1', projectKey: '/repo', createdAt: T0 - 3 }),
          hostRun({ runtimeRunId: 'r2', terminalSessionId: 'p2', projectKey: '/notes', createdAt: T0 - 2 }),
          hostRun({ runtimeRunId: 'r3', terminalSessionId: 'p3', projectKey: '/repo', createdAt: T0 - 1 }),
          hostRun({ runtimeRunId: 'r4', terminalSessionId: 'p4', createdAt: T0 }),
        ],
      }),
    });
    await t.backend.ready;
    expect(t.rows().map((row) => [row.id, row.project.seq])).toEqual([
      ['r1', 0],
      ['r2', 1],
      ['r3', 0],
      ['r4', undefined],
    ]);
    expect([...t.identity.entries()]).toEqual([
      ['/repo', 0],
      ['/notes', 1],
    ]);
  });

  it('deals from the observed directory when the host names no key, and only once the directory is known', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }) });
    await t.backend.ready;
    expect(t.rows()[0]?.project.seq).toBeUndefined();
    t.source.push(monitorState({ environment: { cwd: '/Users/me/site', worktrees: [] } }));
    expect(t.rows()[0]?.project).toEqual({ name: 'site', seq: 0 });
  });

  it('deals nothing for a key the host is still folding (null), then the key the host names', async () => {
    const t = testBackend({
      facts: facts({ runs: [hostRun({ projectKey: null })] }),
      states: [monitorState({ environment: { cwd: '/Users/me/site', worktrees: [] } })],
    });
    await t.backend.ready;
    expect(t.rows()[0]?.project).toEqual({ name: 'site' });
    expect(t.identity.seq('/Users/me/site')).toBeUndefined();
    t.host.update({ runs: [hostRun({ projectKey: '/Users/me/site' })] });
    expect(t.rows()[0]?.project).toEqual({ name: 'site', seq: 0 });
  });

  it('asks the store before dealing, so a host-restored sequence is kept', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun({ projectKey: '/repo' })] }) });
    // the host hands its persisted sequences to the store before the first fold
    t.identity.deal('/other');
    t.identity.deal('/repo');
    await t.backend.ready;
    expect(t.rows()[0]?.project.seq).toBe(1);
  });
});

describe('the spawn menu in the model', () => {
  const sets = [
    { id: 'native', label: 'This Mac', kind: 'native' as const, isDefault: true, personas: [] },
    { id: 'work', label: 'Work', kind: 'managed' as const, isDefault: false, personas: [] },
  ];

  it('rides the first snapshot as reading, then ready when the feed answers, and only a change carries it', async () => {
    const t = testBackend();
    await t.backend.ready;
    t.rows();
    expect(t.backend.getSnapshot().spawn).toEqual({
      devices: [{ id: 'desk-1', label: 'Studio', self: true, state: 'reading' }],
    });
    expect(t.changes.at(-1)).toMatchObject({ since: 0, revision: 1, upserts: [], removed: [] });
    expect(t.changes.at(-1)?.spawn).toBeDefined();
    t.host.update({ profileSets: sets });
    t.rows();
    expect(t.backend.getSnapshot().spawn?.devices[0]).toMatchObject({
      state: 'ready',
      profiles: [{ id: 'native' }, { id: 'work' }],
    });
    expect(t.changes.at(-1)?.spawn).toBe(t.backend.getSnapshot().spawn);
    const revision = t.backend.getSnapshot().revision;
    t.host.update({ profileSets: sets.map((set) => ({ ...set })) });
    t.rows();
    expect(t.backend.getSnapshot().revision).toBe(revision);
  });

  it('lights a profile when an agent under it blocks, and the change carries the menu without touching other rows', async () => {
    const t = testBackend({
      facts: facts({
        runs: [hostRun({ profileSet: 'work' }), hostRun({ runtimeRunId: 'other', terminalSessionId: 'p2' })],
        profileSets: sets,
      }),
      states: [monitorState(), monitorState({ runtimeRunId: 'other' })],
    });
    await t.backend.ready;
    const other = t.rows().find((row) => row.id === 'other');
    t.source.push(
      monitorState({
        revision: 2,
        status: 'blocked',
        blockers: [{ id: 'b', kind: 'permission', since: iso(T0), permission: { requestId: 'r', tool: 'Bash' } }],
      }),
    );
    const change = t.changes.at(-1);
    expect(change?.upserts.map((row) => row.id)).toEqual(['run-1']);
    expect(change?.spawn?.devices[0]?.profiles?.map((profile) => [profile.id, profile.blocked])).toEqual([
      ['native', undefined],
      ['work', true],
    ]);
    expect(t.backend.getSnapshot().rows.find((row) => row.id === 'other')).toBe(other);
    expect(Object.isFrozen(t.backend.getSnapshot().spawn)).toBe(true);
  });

  it('lights no profile for a crashed agent under it, although the row stays for acknowledging (mv-review)', async () => {
    const crashed = (revision: number) =>
      monitorState({
        revision,
        status: 'blocked',
        alive: false,
        activity: undefined,
        blockers: [
          { id: 'run:runtime', kind: 'failure', since: iso(T0), detail: 'exit 1', failure: { code: 'crash' } },
        ],
      });
    const t = testBackend({
      facts: facts({ runs: [hostRun({ profileSet: 'work' })], profileSets: sets }),
      states: [crashed(2)],
    });
    await t.backend.ready;
    expect(t.rows()).toMatchObject([{ id: 'run-1', status: 'blocked', alive: false }]);
    const work = () => t.backend.getSnapshot().spawn?.devices[0]?.profiles?.find((profile) => profile.id === 'work');
    expect(work()).toMatchObject({ id: 'work' });
    expect(work()?.blocked).toBeUndefined();
    // a live agent blocked under the same profile still lights it
    t.host.update({ runs: [...t.host.current().runs, hostRun({ runtimeRunId: 'live', profileSet: 'work' })] });
    t.source.push(monitorState({ runtimeRunId: 'live', status: 'blocked' }));
    t.rows();
    expect(work()).toMatchObject({ id: 'work', blocked: true });
  });
});

describe('emission', () => {
  const twoRuns = () =>
    testBackend({
      facts: facts({
        runs: [
          hostRun({ runtimeRunId: 'a', terminalSessionId: 'pa', createdAt: T0 - 2 }),
          hostRun({ runtimeRunId: 'b', terminalSessionId: 'pb', createdAt: T0 - 1 }),
        ],
      }),
      states: [monitorState({ runtimeRunId: 'a' }), monitorState({ runtimeRunId: 'b' })],
    });

  it('keeps the snapshot and every untouched row by identity, and a state that draws the same row emits nothing', async () => {
    const t = twoRuns();
    await t.backend.ready;
    t.rows();
    const first = t.backend.getSnapshot();
    expect(t.rows()).toBe(first.rows);
    const [a, b] = first.rows;
    // a new revision whose drawn facts are the same: subagents, compaction, fresh evidence
    t.source.push(
      monitorState({
        runtimeRunId: 'a',
        revision: 2,
        subagentCount: 3,
        compaction: { active: true, count: 1 },
        freshness: { level: 'native-hooks', families: {}, lastEvidenceAt: iso(T0 + 1) },
      }),
    );
    t.scheduler.flush();
    expect(t.backend.getSnapshot()).toBe(first);
    // a fact the row draws
    t.source.push(monitorState({ runtimeRunId: 'a', revision: 3, model: { id: 'claude-opus-5-5' } }));
    t.scheduler.flush();
    const second = t.backend.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.rows[0]).not.toBe(a);
    expect(second.rows[1]).toBe(b);
    expect(t.changes.at(-1)).toMatchObject({ upserts: [{ id: 'a', model: 'claude-opus-5-5' }], removed: [] });
  });

  it('emits nothing while idle: ticks, identical host facts, the recency clock', async () => {
    const t = twoRuns();
    await t.backend.ready;
    t.rows();
    const { revision } = t.backend.getSnapshot();
    const emitted = t.changes.length;
    t.scheduler.flush();
    t.host.set({ ...t.host.current(), runs: t.host.current().runs.map((run) => ({ ...run })) });
    t.scheduler.flush();
    t.clock.advance(25_000);
    t.scheduler.flush();
    expect(t.backend.getSnapshot().revision).toBe(revision);
    expect(t.changes.length).toBe(emitted);
  });

  it('chains since to revision, and the changes replayed on an empty model rebuild the snapshot row for row', async () => {
    const t = twoRuns();
    await t.backend.ready;
    t.rows();
    t.source.push(monitorState({ runtimeRunId: 'a', revision: 2, status: 'idle', activity: undefined }));
    t.host.update({
      runs: [hostRun({ runtimeRunId: 'b', terminalSessionId: 'pb', createdAt: T0 - 1 })],
      terminals: [hostTerminal({ sessionId: 'sh' })],
    });
    t.rows();
    t.source.push(monitorState({ runtimeRunId: 'b', revision: 2, effort: { value: 'high' } }));
    t.rows();
    expect(t.changes.length).toBeGreaterThanOrEqual(4);
    let previous = 0;
    const replica = new Map<string, (typeof t.changes)[number]['upserts'][number]>();
    for (const change of t.changes) {
      expect(change.since).toBe(previous);
      expect(change.revision).toBe(previous + 1);
      previous = change.revision;
      for (const id of change.removed) replica.delete(id);
      for (const row of change.upserts) replica.set(row.id, row);
    }
    const snapshot = t.backend.getSnapshot();
    expect(previous).toBe(snapshot.revision);
    expect(replica.size).toBe(snapshot.rows.length);
    for (const row of snapshot.rows) expect(replica.get(row.id)).toBe(row);
    expect(snapshot.rows.map((row) => row.id)).toEqual(['b', 'sh']);
    expect(t.changes.some((change) => change.removed.includes('a'))).toBe(true);
  });

  it('coalesces every non-urgent push in a tick into one change, in the model order', async () => {
    const t = twoRuns();
    await t.backend.ready;
    t.rows();
    const emitted = t.changes.length;
    t.source.push(monitorState({ runtimeRunId: 'b', revision: 2, model: { id: 'm-b' } }));
    t.source.push(monitorState({ runtimeRunId: 'a', revision: 2, model: { id: 'm-a' } }));
    t.source.push(monitorState({ runtimeRunId: 'a', revision: 3, model: { id: 'm-a2' } }));
    expect(t.changes.length).toBe(emitted);
    expect(t.scheduler.pending()).toBe(1);
    t.scheduler.flush();
    expect(t.changes.length).toBe(emitted + 1);
    expect(t.changes.at(-1)?.upserts.map((row) => [row.id, row.model])).toEqual([
      ['a', 'm-a2'],
      ['b', 'm-b'],
    ]);
  });

  it('flushes the urgent facts at once: a blocker, liveness, a removal, a first state', async () => {
    const t = twoRuns();
    await t.backend.ready;
    t.rows();
    const emitted = t.changes.length;
    t.source.push(
      monitorState({
        runtimeRunId: 'a',
        revision: 2,
        status: 'blocked',
        blockers: [{ id: 'q', kind: 'question', since: iso(T0), questions: [{ prompt: 'Deploy?' }] }],
      }),
    );
    expect(t.changes.length).toBe(emitted + 1);
    expect(t.changes.at(-1)?.upserts[0]).toMatchObject({
      id: 'a',
      status: 'blocked',
      wait: { kind: 'question', question: 'Deploy?' },
    });
    t.source.push(monitorState({ runtimeRunId: 'b', revision: 2, alive: false }));
    expect(t.changes.length).toBe(emitted + 2);
    expect(t.changes.at(-1)?.upserts[0]).toMatchObject({ id: 'b', alive: false });
    t.source.remove({ runtimeRunId: 'b', runtimeEpoch: 1 });
    expect(t.changes.length).toBe(emitted + 3);
    expect(t.changes.at(-1)).toMatchObject({ upserts: [], removed: ['b'] });
    t.host.update({ runs: [...t.host.current().runs, hostRun({ runtimeRunId: 'c', terminalSessionId: 'pc' })] });
    t.rows();
    const before = t.changes.length;
    t.source.push(monitorState({ runtimeRunId: 'c' }));
    expect(t.changes.length).toBe(before + 1);
    expect(t.scheduler.pending()).toBe(0);
  });

  it('hands out frozen rows, snapshots and changes', async () => {
    const t = testBackend({
      facts: facts({ runs: [hostRun()], terminals: [hostTerminal()] }),
      states: [
        monitorState({
          usage: { samples: [], costUsd: 1, costCoverage: 'complete', costHistory: [{ at: iso(T0), costUsd: 1 }] },
        }),
      ],
    });
    await t.backend.ready;
    const snapshot = t.backend.getSnapshot();
    t.rows();
    const after = t.backend.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.rows)).toBe(true);
    for (const row of after.rows) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.project)).toBe(true);
      expect(Object.isFrozen(row.device)).toBe(true);
      if (row.cost) expect(Object.isFrozen(row.cost.series?.steps)).toBe(true);
    }
    const change = t.changes.at(-1);
    expect(Object.isFrozen(change)).toBe(true);
    expect(Object.isFrozen(change?.upserts)).toBe(true);
    expect(Object.isFrozen(change?.removed)).toBe(true);
  });

  it('lands every push of a turn in one macrotask with the default scheduler and clock', async () => {
    const source = fakeRunSource([monitorState()]);
    const host = fakeHost(facts({ runs: [hostRun()] }));
    const changes: unknown[] = [];
    const backend = createMonitorBackend({
      runs: source.source,
      host: host.host,
      identity: createMemoryProjectIdentityStore(),
      sink: recordingSink(),
    });
    backend.subscribe((change) => changes.push(change));
    await backend.ready;
    expect(changes).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toHaveLength(1);
    source.push(monitorState({ revision: 2, model: { id: 'one' } }));
    source.push(monitorState({ revision: 3, model: { id: 'two' } }));
    expect(changes).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toHaveLength(2);
    expect(backend.getSnapshot().rows[0]?.model).toBe('two');
    backend.dispose();
  });

  it('keeps ticking with a scheduler that runs the tick at once, before it returns', async () => {
    const source = fakeRunSource([monitorState()]);
    const host = fakeHost(facts({ runs: [hostRun()] }));
    const backend = createMonitorBackend({
      runs: source.source,
      host: host.host,
      identity: createMemoryProjectIdentityStore(),
      sink: recordingSink(),
      clock: manualClock().clock,
      scheduler: (task) => {
        task();
        return () => {};
      },
    });
    await backend.ready;
    expect(backend.getSnapshot().rows).toMatchObject([{ id: 'run-1', observed: true }]);
    // a push that is not urgent and a host change both wait for a tick, which this scheduler runs at once
    source.push(monitorState({ revision: 2, model: { id: 'one' } }));
    expect(backend.getSnapshot().rows[0]?.model).toBe('one');
    host.update({ runs: [hostRun(), hostRun({ runtimeRunId: 'run-2', terminalSessionId: 'pty-2', createdAt: T0 })] });
    expect(backend.getSnapshot().rows.map((row) => row.id)).toEqual(['run-1', 'run-2']);
    backend.dispose();
  });

  it('reports a listener that throws and keeps publishing to the rest; dispose stops everything', async () => {
    const errors: unknown[] = [];
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), onError: (error) => errors.push(error) });
    const seen: number[] = [];
    t.backend.subscribe(() => {
      throw new Error('a bad listener');
    });
    const unsubscribe = t.backend.subscribe((change) => seen.push(change.revision));
    await t.backend.ready;
    t.rows();
    expect(errors).toHaveLength(1);
    expect(seen).toEqual([1]);
    unsubscribe();
    t.source.push(monitorState({ status: 'idle', activity: undefined }));
    expect(seen).toEqual([1]);
    const { revision } = t.backend.getSnapshot();
    t.backend.dispose();
    t.source.push(monitorState({ revision: 5, status: 'blocked', blockers: [] }));
    t.host.update({ runs: [] });
    t.backend.reportShown('w', ['run-1']);
    t.clock.advance(60_000);
    t.scheduler.flush();
    expect(t.backend.getSnapshot().revision).toBe(revision);
    expect(t.backend.command({ type: 'select', id: 'run-1' })).toBe(false);
  });
});

describe('emission while a listener reacts (mv-review finding 1)', () => {
  // A turn finishes while a screen elsewhere shows another row, so it earns the mark (L5, M20); the first listener
  // then does what a host does once a window's active pane shows the row: it reports it shown, synchronously,
  // inside the change callback. That flush must wait for the listener loop, or a later listener hears 2→3 first.
  const reacting = async (react: (t: ReturnType<typeof testBackend>) => void) => {
    const t = testBackend({
      facts: facts({ runs: [hostRun(), hostRun({ runtimeRunId: 'run-2', terminalSessionId: 'pty-2' })] }),
      states: [monitorState(), monitorState({ runtimeRunId: 'run-2' })],
    });
    await t.backend.ready;
    t.backend.reportShown('win-2', ['run-2']);
    t.rows();
    expect(t.backend.getSnapshot().revision).toBe(1);
    let reacted = false;
    t.backend.subscribe(() => {
      if (reacted) return;
      reacted = true;
      react(t);
    });
    return t;
  };
  const finishTurn = (t: ReturnType<typeof testBackend>) => {
    t.clock.advance(1_000);
    t.source.push(monitorState({ revision: 2, status: 'idle', statusSince: iso(T0 + 1_000), activity: undefined }));
  };

  it('a listener that reports shown inside a change: every listener hears 1→2 before 2→3', async () => {
    const t = await reacting((backend) => backend.backend.reportShown('win-1', ['run-1']));
    const heard: Array<{ since: number; revision: number; unread: boolean | undefined }> = [];
    t.backend.subscribe((change) =>
      heard.push({ since: change.since, revision: change.revision, unread: change.upserts[0]?.unread }),
    );
    finishTurn(t);
    expect(heard).toEqual([
      { since: 1, revision: 2, unread: true },
      { since: 2, revision: 3, unread: false },
    ]);
    // the listener installed before the reacting one heard the same chain
    expect(t.changes.slice(-2).map((change) => [change.since, change.revision])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(t.backend.getSnapshot()).toMatchObject({ revision: 3, rows: [{ id: 'run-1', unread: false }, {}] });
  });

  it('…and a replica fed by a later listener applies the whole chain, with no gap', async () => {
    const t = await reacting((backend) => backend.backend.reportShown('win-1', ['run-1']));
    const replica = createMonitorReplica({ scheduler: { request: (work) => (work(), () => {}) } });
    replica.apply(t.backend.getSnapshot());
    let gaps = 0;
    replica.onGap(() => {
      gaps += 1;
    });
    const applied: boolean[] = [];
    t.backend.subscribe((change) => applied.push(replica.apply(change)));
    finishTurn(t);
    expect({ gaps, applied }).toEqual({ gaps: 0, applied: [true, true] });
    expect(replica.getSnapshot().model).toMatchObject({ revision: 3, agents: [{ id: 'run-1', unread: false }, {}] });
  });

  it('holds any flush a listener causes until the loop ends: an urgent push, a removal, a host change', async () => {
    for (const react of [
      (t: ReturnType<typeof testBackend>) =>
        t.source.push(monitorState({ runtimeRunId: 'run-2', revision: 2, status: 'blocked' })),
      (t: ReturnType<typeof testBackend>) => t.source.remove({ runtimeRunId: 'run-2', runtimeEpoch: 1 }),
      (t: ReturnType<typeof testBackend>) => {
        // a host whose scheduler runs the tick at once
        t.host.update({ runs: [hostRun()] });
        t.scheduler.flush();
      },
    ]) {
      const t = await reacting(react);
      const heard: Array<[number, number]> = [];
      t.backend.subscribe((change) => heard.push([change.since, change.revision]));
      finishTurn(t);
      expect(heard).toEqual([
        [1, 2],
        [2, 3],
      ]);
      expect(t.backend.getSnapshot().revision).toBe(3);
    }
  });
});

describe('commands', () => {
  const sets = [
    { id: 'native', label: 'This Mac', kind: 'native' as const, isDefault: true, personas: [] },
    { id: 'work', label: 'Work', kind: 'managed' as const, isDefault: false, personas: [] },
  ];

  it('resolves a select to the row’s run and PTY, a promoted row to its run, a terminal to its PTY', async () => {
    const t = testBackend({
      facts: facts({
        runs: [
          hostRun({ runtimeRunId: 'r1', terminalSessionId: 'pty-1' }),
          hostRun({ runtimeRunId: 'r2', terminalSessionId: undefined }),
        ],
        terminals: [hostTerminal({ sessionId: 'pty-1' }), hostTerminal({ sessionId: 'sh' })],
      }),
    });
    await t.backend.ready;
    expect(t.rows().map((row) => row.id)).toEqual(['pty-1', 'r2', 'sh']);
    expect(t.backend.command({ type: 'select', id: 'pty-1' })).toBe(true);
    expect(t.backend.command({ type: 'select', id: 'r2' })).toBe(true);
    expect(t.backend.command({ type: 'select', id: 'sh' })).toBe(true);
    expect(t.backend.command({ type: 'select', id: 'nobody' })).toBe(false);
    expect(t.sink.selected).toEqual([
      { id: 'pty-1', kind: 'agent', runtimeRunId: 'r1', terminalSessionId: 'pty-1' },
      { id: 'r2', kind: 'agent', runtimeRunId: 'r2' },
      { id: 'sh', kind: 'terminal', terminalSessionId: 'sh' },
    ]);
  });

  it('creates on this desktop by default, under a profile the menu knows, and refuses one it does not', async () => {
    const t = testBackend({ facts: facts({ profileSets: sets }) });
    await t.backend.ready;
    t.rows();
    expect(t.backend.command({ type: 'create' })).toBe(true);
    expect(t.backend.command({ type: 'create', at: { x: 10, y: 20 }, target: { profileSet: 'work' } })).toBe(true);
    expect(t.backend.command({ type: 'create', target: { deviceId: 'desk-1', profileSet: 'play' } })).toBe(false);
    expect(t.backend.command({ type: 'create', target: { deviceId: 'desk-9' } })).toBe(false);
    expect(t.sink.created).toEqual([
      { device: { id: 'desk-1', self: true } },
      { at: { x: 10, y: 20 }, device: { id: 'desk-1', self: true }, profileSet: 'work' },
    ]);
  });

  it('takes a create while this desktop is still reading its profiles, and before the first tick', async () => {
    const t = testBackend();
    expect(t.backend.command({ type: 'create', at: { x: 1, y: 2 } })).toBe(true);
    await t.backend.ready;
    t.rows();
    expect(t.backend.getSnapshot().spawn?.devices[0]?.state).toBe('reading');
    expect(t.backend.command({ type: 'create', target: { profileSet: 'work' } })).toBe(true);
    expect(t.sink.created).toEqual([
      { at: { x: 1, y: 2 }, device: { id: 'desk-1', self: true } },
      { device: { id: 'desk-1', self: true }, profileSet: 'work' },
    ]);
  });

  it('routes to a ready peer and refuses one that is asleep', async () => {
    const t = testBackend({
      facts: facts({
        profileSets: sets,
        spawnPeers: [
          { id: 'laptop', label: 'Laptop', state: 'ready', profiles: [{ id: 'native', label: 'That Mac' }] },
          { id: 'tower', label: 'Tower', state: 'asleep', phrase: 'is asleep' },
        ],
      }),
    });
    await t.backend.ready;
    t.rows();
    expect(t.backend.command({ type: 'create', target: { deviceId: 'laptop', profileSet: 'native' } })).toBe(true);
    expect(t.backend.command({ type: 'create', target: { deviceId: 'laptop', profileSet: 'work' } })).toBe(false);
    expect(t.backend.command({ type: 'create', target: { deviceId: 'tower' } })).toBe(false);
    expect(t.sink.created).toEqual([{ device: { id: 'laptop', self: false }, profileSet: 'native' }]);
  });

  it('reports a sink that throws or rejects, and still counts the command as routed', async () => {
    const errors: unknown[] = [];
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), onError: (error) => errors.push(error) });
    await t.backend.ready;
    t.rows();
    t.sink.select = () => {
      throw new Error('sync');
    };
    t.sink.create = () => Promise.reject(new Error('async'));
    expect(t.backend.command({ type: 'select', id: 'run-1' })).toBe(true);
    expect(t.backend.command({ type: 'create' })).toBe(true);
    await Promise.resolve();
    expect(errors.map((error) => (error as Error).message)).toEqual(['sync', 'async']);
  });
});

describe('observed (M10)', () => {
  it('is false while a run starts or is pending, true once the runtime has spoken, and always true for a terminal', async () => {
    const t = testBackend({
      facts: facts({
        runs: [hostRun(), hostRun({ runtimeRunId: 'held', terminalSessionId: 'p2', pending: 'resume-when-idle' })],
        terminals: [hostTerminal({ sessionId: 'sh' })],
      }),
      states: [monitorState({ runtimeRunId: 'held' })],
    });
    await t.backend.ready;
    expect(t.rows().map((row) => [row.id, row.observed])).toEqual([
      ['held', false],
      ['run-1', false],
      ['sh', true],
    ]);
    t.source.push(monitorState());
    expect(t.rows().find((row) => row.id === 'run-1')).toMatchObject({ observed: true, detail: 'Edit · src/app.ts' });
  });
});

describe('acknowledge (M3)', () => {
  const crashed = (overrides: Partial<ReturnType<typeof monitorState>> = {}) =>
    monitorState({
      revision: 2,
      status: 'blocked',
      alive: false,
      activity: undefined,
      blockers: [{ id: 'run:runtime', kind: 'failure', since: iso(T0), detail: 'exit 1', failure: { code: 'crash' } }],
      ...overrides,
    });

  it('asks the run source to acknowledge a crashed row’s failure; the row goes when the runtime removes the run', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [crashed()] });
    await t.backend.ready;
    expect(t.rows()).toMatchObject([
      { alive: false, status: 'blocked', wait: { kind: 'failure', code: 'crash', detail: 'exit 1' } },
    ]);
    expect(t.backend.command({ type: 'acknowledge', id: 'run-1' })).toBe(true);
    expect(t.source.acknowledged).toEqual([['run-1', 'run:runtime']]);
    t.source.remove({ runtimeRunId: 'run-1', runtimeEpoch: 1 });
    expect(t.backend.getSnapshot().rows).toEqual([]);
    expect(t.changes.at(-1)).toMatchObject({ upserts: [], removed: ['run-1'] });
  });

  it('refuses a live row, a dead row with no failure, an unknown row and a terminal', async () => {
    const t = testBackend({
      facts: facts({
        runs: [hostRun(), hostRun({ runtimeRunId: 'ended', terminalSessionId: 'p2' })],
        terminals: [hostTerminal({ sessionId: 'sh' })],
      }),
      states: [
        monitorState(),
        monitorState({ runtimeRunId: 'ended', status: 'idle', alive: false, activity: undefined }),
      ],
    });
    await t.backend.ready;
    t.rows();
    for (const id of ['run-1', 'ended', 'nobody', 'sh']) {
      expect(t.backend.command({ type: 'acknowledge', id })).toBe(false);
    }
    expect(t.source.acknowledged).toEqual([]);
  });

  it('is not routed on a run source without the verb, and a rejection is reported', async () => {
    const plain = fakeRunSource([crashed()]);
    const bare: typeof plain.source = { ...plain.source };
    delete bare.acknowledgeFailure;
    const scheduler = manualScheduler();
    const backend = createMonitorBackend({
      runs: bare,
      host: fakeHost(facts({ runs: [hostRun()] })).host,
      identity: createMemoryProjectIdentityStore(),
      sink: recordingSink(),
      scheduler: scheduler.scheduler,
      clock: manualClock().clock,
    });
    await backend.ready;
    scheduler.flush();
    expect(backend.getSnapshot().rows).toHaveLength(1);
    expect(backend.command({ type: 'acknowledge', id: 'run-1' })).toBe(false);
    backend.dispose();

    const errors: unknown[] = [];
    const t = testBackend({
      facts: facts({ runs: [hostRun()] }),
      states: [crashed()],
      onError: (error) => errors.push(error),
    });
    await t.backend.ready;
    t.rows();
    t.source.source.acknowledgeFailure = () => Promise.reject(new Error('nope'));
    expect(t.backend.command({ type: 'acknowledge', id: 'run-1' })).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.map((error) => (error as Error).message)).toEqual(['nope']);
  });
});

describe('cost across epochs (M15)', () => {
  const priced = (epoch: number, usd: number) =>
    monitorState({
      runtimeEpoch: epoch,
      session: { nativeSessionId: 'native-1' },
      usage: { samples: [], costUsd: usd, costCoverage: 'complete', costHistory: [{ at: iso(T0), costUsd: usd }] },
    });

  it("'accumulate' (Godview's) adds a resumed epoch of one conversation; 'current' (VibeField's) shows the current epoch alone", async () => {
    for (const [mode, expected] of [
      ['accumulate', 1.75],
      ['current', 0.5],
    ] as const) {
      const t = testBackend({
        facts: facts({ runs: [hostRun()] }),
        states: [priced(1, 1.25)],
        cost: { acrossEpochs: mode },
      });
      await t.backend.ready;
      expect(t.rows()[0]?.cost?.usd).toBe(1.25);
      t.source.push(priced(2, 0.5));
      expect(t.rows()[0]?.cost).toMatchObject({ usd: expected, coverage: 'complete' });
      expect(t.rows()[0]?.cost?.series?.steps.at(-1)).toBe(expected);
    }
  });
});

describe('unobserved agents (M17)', () => {
  const shellAndRun = () =>
    facts({
      runs: [hostRun({ terminalSessionId: 'pty-1' })],
      terminals: [hostTerminal({ sessionId: 'pty-1' })],
    });

  it("'row' (the default, VibeField's): a run before its first state is a starting row that speaks for its terminal", async () => {
    for (const options of [{}, { unobservedAgents: 'row' as const }]) {
      const t = testBackend({ facts: shellAndRun(), ...options });
      await t.backend.ready;
      expect(t.rows().map((row) => [row.id, row.kind, row.observed, row.detail])).toEqual([
        ['pty-1', 'agent', false, 'starting'],
      ]);
    }
  });

  it("'terminal' (Godview's): no agent row before the first state, and the run's terminal stands in, not deduped", async () => {
    const t = testBackend({ facts: shellAndRun(), unobservedAgents: 'terminal' });
    await t.backend.ready;
    expect(t.rows().map((row) => [row.id, row.kind, row.detail])).toEqual([['pty-1', 'terminal', '/Users/me/notes']]);
    // A run with no terminal on this desktop is no row at all until the runtime speaks.
    t.host.update({
      runs: [hostRun({ terminalSessionId: 'pty-1' }), hostRun({ runtimeRunId: 'run-2', terminalSessionId: undefined })],
    });
    expect(t.rows().map((row) => row.id)).toEqual(['pty-1']);
  });

  it("'terminal': the first state promotes the terminal's row in place, at once: the agent takes its id and the shell row goes", async () => {
    const t = testBackend({ facts: shellAndRun(), unobservedAgents: 'terminal' });
    await t.backend.ready;
    const [shell] = t.rows();
    expect(shell).toMatchObject({ id: 'pty-1', kind: 'terminal' });
    const before = t.changes.length;
    t.source.push(monitorState());
    // Urgent: a first state flushes inside the push, with no tick.
    expect(t.changes.length).toBe(before + 1);
    expect(t.backend.getSnapshot().rows.map((row) => [row.id, row.kind, row.observed, row.detail])).toEqual([
      ['pty-1', 'agent', true, 'Edit · src/app.ts'],
    ]);
    expect(t.changes.at(-1)).toMatchObject({ upserts: [{ id: 'pty-1', kind: 'agent' }], removed: [] });
    expect(t.backend.getSnapshot().rows[0]).not.toBe(shell);
  });

  it("'terminal': a run on no terminal appears under its own id at its first state, and goes with its removal", async () => {
    const t = testBackend({
      facts: facts({ runs: [hostRun({ terminalSessionId: undefined })] }),
      unobservedAgents: 'terminal',
    });
    await t.backend.ready;
    expect(t.rows()).toEqual([]);
    t.source.push(monitorState());
    expect(t.backend.getSnapshot().rows.map((row) => [row.id, row.kind])).toEqual([['run-1', 'agent']]);
    t.source.remove({ runtimeRunId: 'run-1', runtimeEpoch: 1 });
    expect(t.backend.getSnapshot().rows).toEqual([]);
  });

  it("'terminal': once the runtime removes the run, its terminal is a terminal row again under the same id", async () => {
    const t = testBackend({ facts: shellAndRun(), states: [monitorState()], unobservedAgents: 'terminal' });
    await t.backend.ready;
    expect(t.rows().map((row) => [row.id, row.kind])).toEqual([['pty-1', 'agent']]);
    t.source.remove({ runtimeRunId: 'run-1', runtimeEpoch: 1 });
    expect(t.rows().map((row) => [row.id, row.kind])).toEqual([['pty-1', 'terminal']]);
  });

  it("'terminal' leaves an observed run exactly as 'row' does", async () => {
    const rows = async (unobservedAgents: 'row' | 'terminal') => {
      const t = testBackend({ facts: shellAndRun(), states: [monitorState()], unobservedAgents });
      await t.backend.ready;
      return t.rows();
    };
    expect(await rows('terminal')).toEqual(await rows('row'));
  });
});

describe('text bounds (M21)', () => {
  const long = (word: string, length: number) => word.repeat(length).slice(0, length);
  const wordy = () =>
    monitorState({
      status: 'blocked',
      activity: { kind: 'tool', line: long('line', 900), since: iso(T0) },
      lastAssistantMessage: { text: long('reply', 1_200), at: iso(T0), final: true },
      blockers: [
        {
          id: 'q',
          kind: 'question',
          since: iso(T0),
          detail: long('detail', 600),
          questions: [{ header: long('header', 400), prompt: long('prompt', 700) }],
        },
      ],
    });

  it('adds no bound of its own by default: Core already bounds the mirror, and this window reads it whole', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [wordy()] });
    await t.backend.ready;
    const [row] = t.rows();
    expect(row?.reply?.text).toHaveLength(1_200);
    expect(row?.activity?.line).toHaveLength(900);
    expect([row?.wait?.question, row?.wait?.header, row?.wait?.detail].map((text) => text?.length)).toEqual([
      700, 400, 600,
    ]);
  });

  it('bounds every text by code points when a host passes replyMaxLength, trimmed as before', async () => {
    const t = testBackend({ facts: facts({ runs: [hostRun()] }), states: [wordy()], replyMaxLength: 280 });
    await t.backend.ready;
    const [row] = t.rows();
    expect(
      [row?.reply?.text, row?.activity?.line, row?.wait?.question, row?.wait?.header, row?.wait?.detail].map(
        (text) => text?.length,
      ),
    ).toEqual([280, 280, 280, 280, 280]);
  });
});
