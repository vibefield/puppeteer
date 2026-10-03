import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_TINT, projectTint } from '../colour/project-tint.js';
import type { MonitorAgent } from '../monitor/types.js';
import { LAB_AGENT_COUNTS, LAB_NOW_MS, labWorld, seededRandom } from './lab-world.js';

const serialise = (world: ReturnType<typeof labWorld>): string =>
  JSON.stringify({ ...world, history: { ...world.history, lanes: [...world.history.lanes] } });

describe('labWorld', () => {
  it('is the same world for the same n and seed, at the fixed clock', () => {
    for (const n of LAB_AGENT_COUNTS) expect(serialise(labWorld({ n }))).toBe(serialise(labWorld({ n })));
    expect(labWorld({ n: 1 }).nowMs).toBe(LAB_NOW_MS);
    expect(serialise(labWorld({ n: 20, seed: 'other' }))).not.toBe(serialise(labWorld({ n: 20 })));
  });

  it('holds exactly n rows with unique ids, one of them the active pane', () => {
    for (const n of LAB_AGENT_COUNTS) {
      const { agents } = labWorld({ n });
      expect(agents).toHaveLength(n);
      expect(new Set(agents.map((agent) => agent.id)).size).toBe(n);
      expect(agents.filter((agent) => agent.active)).toHaveLength(n === 0 ? 0 : 1);
    }
    const [only] = labWorld({ n: 1 }).agents;
    expect(only).toMatchObject({ status: 'working', active: true });
    expect(only?.agent?.monitor?.activity?.kind).toBe('tool');
  });

  it('covers every state a view draws once n reaches twenty', () => {
    const { agents } = labWorld({ n: 20 });
    const has = (predicate: (agent: MonitorAgent) => boolean): boolean => agents.some(predicate);
    expect(new Set(agents.map((agent) => agent.status))).toEqual(new Set(['working', 'blocked', 'idle']));
    const waits = new Set(agents.flatMap((agent) => agent.agent?.monitor?.blockers.map((b) => b.kind) ?? []));
    expect(waits).toEqual(new Set(['permission', 'question', 'failure']));
    expect(has((agent) => agent.unread === true)).toBe(true);
    expect(has((agent) => agent.receded === true)).toBe(true);
    expect(has((agent) => agent.stale === true)).toBe(true);
    expect(has((agent) => !agent.agent && agent.status === 'working')).toBe(true);
    expect(has((agent) => !agent.agent && agent.status === 'idle')).toBe(true);
    expect(agents.filter((agent) => agent.remote).map((agent) => agent.status)).toEqual(
      expect.arrayContaining(['working', 'blocked', 'idle']),
    );
    expect(has((agent) => agent.project.length > 40 && (agent.agent?.model?.length ?? 0) > 40)).toBe(true);
    // Missing facets: a run not heard from yet, and one with no model, branch, context or prices.
    expect(has((agent) => agent.agent !== undefined && agent.agent.monitor === undefined)).toBe(true);
    expect(
      has(
        (agent) =>
          agent.agent?.monitor !== undefined &&
          !agent.agent.model &&
          !agent.agent.branch &&
          !agent.agent.contextWindow &&
          !agent.agent.usage,
      ),
    ).toBe(true);
    expect(has((agent) => (agent.attachment?.paneIds.length ?? 0) > 1)).toBe(true);
  });

  it('orders agents, then peers, then bare terminals, as a host assembles them', () => {
    const rank = (agent: MonitorAgent): number => (!agent.agent ? 2 : agent.remote ? 1 : 0);
    const ranks = labWorld({ n: 60 }).agents.map(rank);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
  });

  it('deals colours from the tint it is given, and the ramp to bare terminals', () => {
    const tint = DEFAULT_PROJECT_TINT.dark;
    const { agents } = labWorld({ n: 20, tint, neutral: 'rgb(1, 2, 3)' });
    const local = agents.filter((agent) => agent.agent && !agent.remote);
    expect(local[0]?.color).toBe(projectTint(0, tint));
    for (const agent of agents) if (!agent.agent) expect(agent.color).toBe('rgb(1, 2, 3)');
    const byProject = new Map<string, string>();
    for (const agent of agents.filter((row) => row.agent)) {
      expect(byProject.get(agent.project) ?? agent.color).toBe(agent.color);
      byProject.set(agent.project, agent.color);
    }
  });

  it('books every lane to its current state, contiguous back to its birth', () => {
    const { agents, history } = labWorld({ n: 60 });
    for (const agent of agents) {
      const lane = history.lanes.get(agent.id);
      expect(lane, agent.id).toBeDefined();
      const spans = lane!.spans;
      const open = spans[spans.length - 1]!;
      expect(open.toMs).toBeUndefined();
      expect(open.status).toBe(agent.status === 'idle' && agent.unread ? 'unseen' : agent.status);
      expect(spans[0]!.fromMs).toBe(agent.createdAtMs);
      for (let index = 1; index < spans.length; index += 1) expect(spans[index]!.fromMs).toBe(spans[index - 1]!.toMs);
      expect(lane!.recordedFromMs).toBeGreaterThanOrEqual(agent.createdAtMs);
    }
    expect(history.ended.map((agent) => agent.id)).toEqual(['ended']);
    expect(history.lanes.get('ended')?.endedAtMs).toBeLessThan(LAB_NOW_MS);
    expect(labWorld({ n: 1 }).history.ended).toEqual([]);
  });
});

describe('seededRandom', () => {
  it('repeats its sequence for the same text, in [0, 1)', () => {
    const a = seededRandom('mv0');
    const b = seededRandom('mv0');
    const draws = Array.from({ length: 50 }, () => a());
    expect(draws).toEqual(Array.from({ length: 50 }, () => b()));
    for (const draw of draws) expect(draw >= 0 && draw < 1).toBe(true);
  });
});
