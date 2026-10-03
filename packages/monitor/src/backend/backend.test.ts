import { describe, expect, it } from 'vitest';
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
