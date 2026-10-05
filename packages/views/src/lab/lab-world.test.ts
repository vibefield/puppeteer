import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_TINT, projectTint } from '../colour/project-tint.js';
import type { MonitorAgent } from '../monitor/types.js';
import { LAB_AGENT_COUNTS, LAB_NOW_MS, labWorld, seededRandom } from './lab-world.js';

const serialise = (world: ReturnType<typeof labWorld>): string => JSON.stringify(world);

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
    // Bare terminals and peers' rows wear the ramp: neither has a project of this desktop's (M16).
    for (const agent of agents) if (!agent.agent || agent.remote) expect(agent.color).toBe('rgb(1, 2, 3)');
    const byProject = new Map<string, string>();
    for (const agent of agents.filter((row) => row.agent && !row.remote)) {
      expect(byProject.get(agent.project) ?? agent.color).toBe(agent.color);
      byProject.set(agent.project, agent.color);
    }
  });
});

describe('labWorld churn', () => {
  it('moves exactly three rows and adds one, leaving every other row as it was', () => {
    const before = labWorld({ n: 20 });
    const after = labWorld({ n: 20, churn: true });
    const byId = (world: ReturnType<typeof labWorld>) => new Map(world.agents.map((agent) => [agent.id, agent]));
    const was = byId(before);
    const now = byId(after);
    expect(now.get('working-full')).toMatchObject({ status: 'blocked' });
    expect(now.get('working-full')?.agent?.monitor?.blockers.map((blocker) => blocker.kind)).toEqual(['permission']);
    expect(now.get('blocked-question')).toMatchObject({ status: 'working' });
    expect(now.get('blocked-question')?.agent?.monitor?.blockers).toEqual([]);
    expect(now.has('idle-unread')).toBe(false);
    expect(now.get('late-arrival')).toMatchObject({ status: 'working' });
    for (const [id, agent] of now) {
      if (['working-full', 'blocked-question', 'late-arrival'].includes(id)) continue;
      expect(agent, id).toEqual(was.get(id));
    }
    expect(now.get('working-full')?.agent?.monitor?.statusSince).toBe(new Date(LAB_NOW_MS).toISOString());
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
