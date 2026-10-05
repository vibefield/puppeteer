import { describe, expect, it } from 'vitest';
import { toMonitorAgent, viewReadProjection, type LegacyShimOptions } from '../legacy/index.js';
import { LAB_AGENT_COUNTS, labWorld } from './lab-world.js';
import { labAgentView, labModel } from './lab-model.js';

/** Puppeteer Godview's shim options (M4, M9): its labs and goldens drew the world in these words. */
const GODVIEW: LegacyShimOptions = { detail: 'headline-cost', peerMonitor: 'map' };

describe('the lab model', () => {
  it('is the world, row for row, in the world’s own order', () => {
    for (const n of LAB_AGENT_COUNTS) {
      const world = labWorld({ n });
      const model = labModel({ n });
      expect(model.agents.map((agent) => agent.id)).toEqual(world.agents.map((agent) => agent.id));
      expect([...model.byId.keys()]).toEqual(world.agents.map((agent) => agent.id));
    }
  });

  it('gives back every fact a view reads of the world, through the shim in Godview’s words', () => {
    for (const churn of [false, true]) {
      const world = labWorld({ n: 60, churn });
      for (const row of world.agents) {
        const legacy = viewReadProjection(row);
        const back = viewReadProjection(toMonitorAgent(labAgentView(row, world.nowMs), GODVIEW));
        // The one fact that differs: a run not heard from yet. The world's row says only "starting", as a host that
        // draws such rows (VibeField) words it; Godview's own line appends the cost it does not have. Godview never
        // shows such a row (M17), and reply-first (every ported view, M4) says "starting" alone.
        if (row.agent && !row.agent.monitor) {
          expect(row.detail).toBe('starting');
          expect(back.detail).toBe('starting · cost unavailable');
          expect({ ...back, detail: row.detail }).toEqual(legacy);
          continue;
        }
        // An unpriced provider: the world's mirror says its price lane is `unavailable`; the backend gives no cost
        // at all (absent when nothing is priced), so the shim says nothing. Accepted as invisible in M27's list (the
        // swarm draws "—" either way); neither the list nor the rain reads it.
        if (row.agent?.monitor?.usage.costCoverage === 'unavailable') {
          expect(legacy.agent?.monitor?.usage).toEqual({ costCoverage: 'unavailable' });
          expect(back.agent?.monitor?.usage).toBeUndefined();
          const { usage: _usage, ...monitor } = legacy.agent!.monitor!;
          expect(back).toEqual({ ...legacy, agent: { ...legacy.agent, monitor } });
          continue;
        }
        expect(back).toEqual(legacy);
      }
    }
  });

  it('covers every case the parity and the goldens rely on', () => {
    const { agents } = labModel({ n: 20 });
    const has = (predicate: (agent: (typeof agents)[number]) => boolean) => agents.some(predicate);
    expect(new Set(agents.map((agent) => agent.status))).toEqual(new Set(['working', 'blocked', 'idle']));
    expect(new Set(agents.flatMap((agent) => (agent.wait ? [agent.wait.kind] : [])))).toEqual(
      new Set(['permission', 'question', 'failure']),
    );
    expect(has((agent) => agent.kind === 'terminal' && agent.status === 'working')).toBe(true);
    expect(has((agent) => agent.kind === 'terminal' && agent.status === 'idle')).toBe(true);
    expect(has((agent) => !agent.device.self && agent.writable)).toBe(true);
    expect(has((agent) => !agent.device.self && !agent.writable)).toBe(true);
    expect(has((agent) => !agent.device.self && !agent.attachable && agent.writable)).toBe(true);
    for (const fact of ['unread', 'receded', 'active', 'stale'] as const)
      expect(has((agent) => agent[fact])).toBe(true);
    expect(has((agent) => (agent.attachment?.panes ?? 0) > 1)).toBe(true);
    expect(has((agent) => !agent.observed)).toBe(true);
    expect(has((agent) => agent.reply !== undefined)).toBe(true);
    expect(has((agent) => agent.cost?.coverage === 'unavailable' || (agent.kind === 'agent' && !agent.cost))).toBe(
      true,
    );
  });
});
