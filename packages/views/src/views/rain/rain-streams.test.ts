import { describe, expect, it } from 'vitest';
import type { AgentView } from '@vibecook/puppeteer-view-sdk';
import { agentViewFixture, type AgentViewFixturePartial } from '@vibecook/puppeteer-view-sdk/testing';
import { rainDataString, rainTailLength, reconcileRainColumns, type RainDrop } from './rain-streams.js';

const row = (overrides: AgentViewFixturePartial): AgentView =>
  agentViewFixture({ id: 'row', project: { name: 'vibe-field' }, ...overrides });
const terminal = (overrides: AgentViewFixturePartial = {}): AgentView => row({ kind: 'terminal', ...overrides });
const PEER = { id: 'mini', name: 'studio-mini', self: false } as const;

describe('rainDataString', () => {
  it('reads an agent row as its project, branch, model and context', () => {
    const text = rainDataString(
      row({
        project: { name: 'vibe-field', branch: 'main' },
        provider: { id: 'claude', label: 'Claude' },
        model: 'Opus',
        context: { usedPercent: 42 },
      }),
    );
    expect(text).toBe(' vibe field main Opus CTX 42% ');
  });

  it('names an agent with no model by its provider, and pads a context under ten', () => {
    expect(rainDataString(row({ provider: { id: 'claude', label: 'Claude' }, context: { usedPercent: 4.6 } }))).toBe(
      ' vibe field Claude CTX 05% ',
    );
  });

  it('reads an unclaimed terminal as its project and the word terminal', () => {
    // Hyphens flatten to spaces with every other symbol: one grid-width glyph
    // per cell is what keeps a stream a column rather than a ragged edge.
    expect(rainDataString(terminal())).toBe(' vibe field terminal ');
  });

  it('names the PEER on a remote terminal, first, so the column cannot be misread', () => {
    expect(rainDataString(terminal({ device: PEER, writable: true }))).toBe(' studio mini vibe field ');
  });

  it('says a read-only host in the stream from the row’s own policy (M41), and nothing when it permits writes', () => {
    expect(rainDataString(terminal({ device: PEER, writable: false }))).toContain('read only host');
    expect(rainDataString(terminal({ device: PEER, writable: true }))).not.toContain('host');
    // `attachable` says nothing about writing.
    expect(rainDataString(terminal({ device: PEER, writable: true, attachable: false }))).not.toContain('host');
  });

  it('reads a peer’s agent like a local one, its context included (M9)', () => {
    expect(rainDataString(row({ device: PEER, model: 'Opus', context: { usedPercent: 12 } }))).toBe(
      ' vibe field Opus CTX 12% ',
    );
  });
});

describe('rainTailLength', () => {
  it('reads an unmeasured context window as mid-scale and floors every tail at its text', () => {
    expect(rainTailLength(row({}), 40, 1, 10)).toBe(18);
    expect(rainTailLength(row({}), 4, 1, 10)).toBe(16);
    expect(rainTailLength(row({ context: { usedPercent: 100 } }), 40, 1, 10)).toBe(36);
    // A terminal has no context window to read.
    expect(rainTailLength(terminal({ context: { usedPercent: 100 } }), 40, 1, 10)).toBe(18);
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
