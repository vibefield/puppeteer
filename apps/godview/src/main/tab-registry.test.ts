import { describe, expect, it } from 'vitest';
import { GodviewTabRegistry } from './tab-registry.js';

describe('GodviewTabRegistry', () => {
  it('isolates session ownership and tab order by native group', () => {
    const registry = new GodviewTabRegistry<object>();
    const first = {};
    const second = {};
    const otherWindow = {};
    registry.add(first, 'first', 'group-a');
    registry.add(second, 'second', 'group-a');
    registry.add(otherWindow, 'other', 'group-b');
    const workspace = {
      version: 1 as const,
      root: {
        kind: 'pane' as const,
        id: 'pane',
        sessionId: 'session-2',
        meta: {
          type: 'godview-pane-recovery' as const,
          version: 1 as const,
          exited: false,
          descriptor: { kind: 'terminal' as const, cwd: '/repo' },
        },
      },
      activePaneId: 'pane',
      zoomedPaneId: null,
    };
    expect(registry.updateSessions(second, ['session-2'], workspace)).toEqual({
      sessionsChanged: true,
      workspaceChanged: true,
      detachedSessionIds: [],
    });

    expect(registry.group('group-a').map((record) => record.id)).toEqual(['first', 'second']);
    expect(registry.tabAt(first, 9)?.id).toBe('second');
    expect(registry.get(second)?.sessionIds).toEqual(new Set(['session-2']));
    expect(registry.get(second)?.workspace).toEqual(workspace);
    expect(registry.get(otherWindow)?.sessionIds).toEqual(new Set());
    registry.queueRestoreWorkspace(second, workspace);
    expect(registry.takeRestoreWorkspace(second)).toEqual(workspace);
    expect(registry.takeRestoreWorkspace(second)).toEqual(workspace);
    registry.updateSessions(second, ['session-2'], workspace);
    expect(registry.takeRestoreWorkspace(second)).toBeUndefined();
  });

  it('removes only the closed tab', () => {
    const registry = new GodviewTabRegistry<object>();
    const first = {};
    const second = {};
    registry.add(first, 'first', 'group');
    registry.add(second, 'second', 'group');

    expect(registry.delete(first)?.id).toBe('first');
    expect(registry.group('group').map((record) => record.id)).toEqual(['second']);
  });

  it('reports a removed session only after its final mirrored attachment is gone', () => {
    const registry = new GodviewTabRegistry<object>();
    const first = {};
    const second = {};
    registry.add(first, 'first', 'group');
    registry.add(second, 'second', 'group');
    registry.updateSessions(first, ['shared']);
    registry.updateSessions(second, ['shared']);

    expect(registry.updateSessions(first, []).detachedSessionIds).toEqual([]);
    expect(registry.updateSessions(second, []).detachedSessionIds).toEqual(['shared']);
  });

  it('atomically replaces an exited session in every owning viewport', () => {
    const registry = new GodviewTabRegistry<object>();
    const first = {};
    const second = {};
    const unrelated = {};
    const recovery = {
      type: 'godview-pane-recovery' as const,
      version: 1 as const,
      exited: false,
      descriptor: {
        kind: 'agent' as const,
        agent: 'claude',
        nativeSessionId: 'native',
        cwd: '/repo',
        workspace: { mode: 'direct', root: '/repo', sourcePath: '/repo' },
      },
    };
    const workspace = {
      version: 1 as const,
      root: { kind: 'pane' as const, id: 'pane', sessionId: 'agent', meta: recovery },
      activePaneId: 'pane',
      zoomedPaneId: null,
    };
    registry.add(first, 'first', 'group');
    registry.add(second, 'second', 'group');
    registry.add(unrelated, 'unrelated', 'group');
    registry.updateSessions(first, ['agent'], workspace);
    registry.updateSessions(second, ['agent'], workspace);

    expect(registry.replaceSession('agent', { id: 'shell', cwd: '/repo' }).map((record) => record.id)).toEqual([
      'first',
      'second',
    ]);
    expect(registry.get(first)?.sessionIds).toEqual(new Set(['shell']));
    expect(registry.get(first)?.workspace?.root).toMatchObject({
      id: 'pane',
      sessionId: 'shell',
      meta: { descriptor: { kind: 'terminal', cwd: '/repo' } },
    });
    expect(registry.takeRestoreWorkspace(second)?.root).toMatchObject({ sessionId: 'shell' });
    expect(registry.get(unrelated)?.sessionIds).toEqual(new Set());
  });
});
