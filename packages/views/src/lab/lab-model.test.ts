import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LAB_AGENT_COUNTS, labWorld } from './lab-world.js';
import { labAgentView, labModel } from './lab-model.js';

describe('the lab model', () => {
  it('is the world, row for row, in the world’s own order', () => {
    for (const n of LAB_AGENT_COUNTS) {
      const world = labWorld({ n });
      const model = labModel({ n });
      expect(model.agents.map((agent) => agent.id)).toEqual(world.agents.map((agent) => agent.id));
      expect([...model.byId.keys()]).toEqual(world.agents.map((agent) => agent.id));
    }
  });

  it('says each row’s identity, birth, state and colour as the world’s row does', () => {
    for (const churn of [false, true]) {
      const world = labWorld({ n: 60, churn });
      for (const row of world.agents) {
        const view = labAgentView(row, world.nowMs);
        expect([view.id, view.kind, view.createdAt, view.status, view.colour, view.active]).toEqual([
          row.id,
          row.agent ? 'agent' : 'terminal',
          row.createdAtMs,
          row.status,
          row.color,
          row.active,
        ]);
        expect([view.stale, view.unread, view.receded, view.device.self]).toEqual([
          row.stale === true,
          row.unread === true,
          row.receded === true,
          row.remote === undefined,
        ]);
        expect(view.attachment?.panes).toBe(row.attachment?.paneIds.length);
      }
    }
  });

  // The model every lab and golden draws, pinned (MV-8). It was proved fact for fact against the world through the
  // legacy shim until the shim went; the goldens recorded on it are the witnesses of what it draws, and this holds
  // the model itself to the one they were taken on.
  it('is the model the goldens were recorded on, byte for byte', () => {
    const digests: Record<string, string> = {};
    for (const n of [1, 20, 60]) {
      for (const churn of [false, true]) {
        digests[`n${n}${churn ? ' churned' : ''}`] = createHash('sha256')
          .update(JSON.stringify(labModel({ n, churn }).agents))
          .digest('hex');
      }
    }
    expect(digests).toEqual({
      n1: '6e2dd2f8d636970969300548337e5139c5ec7c40d5879c5bbe25a8f7ba045d16',
      'n1 churned': '7f870a037f3d66cbb956f7db4100492678c4724b014dfd762b52fc2c9484d054',
      n20: 'b724033839fb4000c7873d086dac3c299262462d309b9dc8ac7eea166caccc37',
      'n20 churned': '75149118a6c3b60176eb72ed49f837cdb637b8ac6bcf27e730a5323f4a658e04',
      n60: 'e52d91f60063e91dccad3dc1b7c44fae4d4b6b4928b6db888ad9a8eb7e7d2eeb',
      'n60 churned': 'cb4dfe29f05c4118eb8eaa115a7b6ff6dd6df495e1d8b48d1a1d4ae4d7e24537',
    });
  });

  it('covers every case the goldens rely on', () => {
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
