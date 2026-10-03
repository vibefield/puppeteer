import { describe, expect, it } from 'vitest';
import { DEVICE, T0, facts, hostRun, hostTerminal, iso, monitorState, testBackend } from './testing/fixtures.js';

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
