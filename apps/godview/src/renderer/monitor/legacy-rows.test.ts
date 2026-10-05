import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentView, MonitorModel } from '@vibecook/puppeteer-view-sdk/model';
import { createLegacyRows, type LegacyRowsFacts } from './legacy-rows.js';

function view(id: string, kind: 'agent' | 'terminal', createdAt: number): AgentView {
  return Object.freeze({
    id,
    kind,
    createdAt,
    status: 'idle',
    statusSince: createdAt,
    stale: false,
    alive: true,
    observed: true,
    detail: kind === 'agent' ? 'idle' : '/repos/app',
    project: { name: 'app' },
    unread: false,
    device: { id: 'mac', name: 'Mac', self: true },
    attachable: true,
    writable: true,
    colour: '#888',
    active: false,
    receded: false,
    ...(kind === 'agent' ? { provider: { id: 'codex', label: 'Codex' } } : {}),
  }) as AgentView;
}

function model(...agents: AgentView[]): MonitorModel {
  return Object.freeze({ revision: 1, agents, byId: new Map(agents.map((agent) => [agent.id, agent] as const)) });
}

const session = (id: string): SessionSummary => ({ id, exited: false, createdAtMs: 0 }) as SessionSummary;

describe('the legacy rows', () => {
  it("wear the visual id the window carried (a launcher's agent keeps the fresh shell's body)", () => {
    const facts: LegacyRowsFacts = {
      agentSessions: new Map([['ag-r', 'ag-r']]),
      terminals: [],
      identities: undefined,
      visualIds: new Map([['ag-r', 'sh-f']]),
    };
    const rows = createLegacyRows().rowsFor(model(view('ag-r', 'agent', 2)), facts);
    expect(rows.map((row) => [row.id, row.visualId ?? row.id])).toEqual([['ag-r', 'sh-f']]);
  });

  it('draw one body per visual identity: the earlier row (agents first) speaks for it', () => {
    const facts: LegacyRowsFacts = {
      agentSessions: new Map([['ag-r', 'ag-r']]),
      terminals: [{ session: session('sh-f') }],
      identities: undefined,
      visualIds: new Map([['ag-r', 'sh-f']]),
    };
    const legacy = createLegacyRows();
    const both = model(view('ag-r', 'agent', 2), view('sh-f', 'terminal', 1));
    expect(legacy.rowsFor(both, facts).map((row) => row.id)).toEqual(['ag-r']);
    // Once the shell leaves, nothing changes for the agent's row: the same object.
    const first = legacy.rowsFor(both, facts)[0];
    const after = legacy.rowsFor(model(both.agents[0]!), { ...facts, terminals: [] });
    expect(after[0]).toBe(first);
  });

  it('keep identity: the same model and facts give the same list, an unmoved row its object', () => {
    const facts: LegacyRowsFacts = {
      agentSessions: new Map(),
      terminals: [],
      identities: undefined,
      visualIds: undefined,
    };
    const legacy = createLegacyRows();
    const a = view('ag-1', 'agent', 1);
    const first = legacy.rowsFor(model(a), facts);
    expect(legacy.rowsFor(model(a), facts)[0]).toBe(first[0]);
    const same = model(a);
    expect(legacy.rowsFor(same, facts)).toBe(legacy.rowsFor(same, facts));
  });
});
