import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { MonitorAgent } from '../../monitor/types.js';
import { rainDataString, rainTailLength, reconcileRainColumns, type RainDrop } from './rain-streams.js';

function row(overrides: Partial<MonitorAgent>): MonitorAgent {
  return {
    id: 'row',
    session: { id: 'row', exited: false, createdAtMs: 0 } as SessionSummary,
    status: 'idle',
    project: 'vibe-field',
    detail: '',
    color: '#6366f1',
    active: false,
    ...overrides,
  };
}

describe('rainDataString', () => {
  it('reads an agent row as its project, branch, model and context', () => {
    const text = rainDataString(
      row({
        agent: {
          provider: { id: 'claude', label: 'Claude' },
          model: 'Opus',
          branch: 'main',
          contextWindow: { usedPercent: 42, percentageSource: 'provider', asOf: '2026-09-02T00:00:00.000Z' },
          monitor: {} as never,
          recency: 'fresh',
          info: {} as never,
        },
      }),
    );
    expect(text).toContain('vibe field');
    expect(text).toContain('main');
    expect(text).toContain('Opus');
    expect(text).toContain('CTX 42%');
  });

  it('reads an unclaimed terminal as its project and the word terminal', () => {
    // Hyphens flatten to spaces with every other symbol: one grid-width glyph
    // per cell is what keeps a stream a column rather than a ragged edge.
    expect(rainDataString(row({}))).toBe(' vibe field terminal ');
  });
});

describe('rainTailLength', () => {
  it('reads an unmeasured context window as mid-scale and floors every tail at its text', () => {
    expect(rainTailLength(row({}), 40, 1, 10)).toBe(18);
    expect(rainTailLength(row({}), 4, 1, 10)).toBe(16);
  });
});

describe('reconcileRainColumns', () => {
  const createDrop = (agentId: string): RainDrop => ({ agentId, y: 0, speed: 0.5 });

  it('keeps placed agents where they are and only places newcomers', () => {
    const first = reconcileRainColumns({ agents: ['a', 'b'], columns: 12, previous: new Map(), createDrop });
    const held = [...first.entries()].filter(([, drop]) => drop.agentId === 'a').map(([column]) => column);
    const second = reconcileRainColumns({ agents: ['a', 'b', 'c'], columns: 12, previous: first, createDrop });
    for (const column of held) expect(second.get(column)?.agentId).toBe('a');
    expect([...second.values()].some((drop) => drop.agentId === 'c')).toBe(true);
  });

  it('drops the streams of agents that left and columns that no longer exist', () => {
    const first = reconcileRainColumns({ agents: ['a', 'b'], columns: 12, previous: new Map(), createDrop });
    const next = reconcileRainColumns({ agents: ['b'], columns: 3, previous: first, createDrop });
    expect([...next.values()].every((drop) => drop.agentId === 'b')).toBe(true);
    expect([...next.keys()].every((column) => column < 3)).toBe(true);
  });

  it('places a newcomer immediately when existing agents give up their second streams', () => {
    const first = reconcileRainColumns({ agents: ['a', 'b'], columns: 4, previous: new Map(), createDrop });
    const next = reconcileRainColumns({ agents: ['c', 'a', 'b'], columns: 4, previous: first, createDrop });

    expect([...next.values()].map((drop) => drop.agentId).sort()).toEqual(['a', 'b', 'c']);
    for (const agentId of ['a', 'b']) {
      const [column, drop] = [...first.entries()].find(([, candidate]) => candidate.agentId === agentId)!;
      expect(next.get(column)).toBe(drop);
    }
  });
});
