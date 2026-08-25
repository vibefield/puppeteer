import { describe, expect, it } from 'vitest';
import { unknownSessionActivity, type SessionSummary } from '@vibecook/ghosttea-protocol';
import type { AgentSessionInfo } from './protocol.js';
import {
  buildRestoreSnapshot,
  paneRecoveryMetadata,
  preferredRestoreWindow,
  readRestoreDescriptor,
  readRestoreSnapshot,
  readRestoreWorkspaceDocument,
  replaceRestoreWorkspaceSession,
  restoredAgentOptions,
  snapshotReferencedSessionIds,
  summarizeRestoreSnapshot,
  type RestoreAgentLaunchProvenance,
} from './restore-snapshot.js';
import { claudeRestoreLaunchProvenance } from './main/restore-launch.js';

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    handle: id,
    executable: '/bin/zsh',
    cols: 100,
    rows: 30,
    exited: false,
    readWrite: true,
    title: null,
    cwd: '/repo',
    bellCount: 0,
    pid: 1,
    createdAtMs: 1,
    exitCode: null,
    exitSignal: null,
    requestedTermination: null,
    exitOutcome: null,
    ownerId: null,
    persistence: 'terminate-with-app',
    activity: unknownSessionActivity(),
    ...overrides,
  };
}

function agent(runtimeSessionId: string, nativeSessionId = `native-${runtimeSessionId}`): AgentSessionInfo {
  return {
    agent: 'claude',
    runtimeRunId: `run-${runtimeSessionId}`,
    runtimeEpoch: 1,
    terminalSessionId: runtimeSessionId,
    nativeSession: { namespace: 'claude', id: nativeSessionId, basis: 'observed', quality: 'exact' },
    nativeSessionRevision: 1,
    externalRefs: [],
    sessionId: nativeSessionId,
    runtimeSessionId,
    workspace: {
      mode: 'worktree',
      root: `/worktrees/${runtimeSessionId}`,
      sourcePath: '/repo',
      branch: `chopsticks/${runtimeSessionId}`,
    },
    session: session(runtimeSessionId),
  };
}

describe('restore snapshot schema', () => {
  it('stores one complete workspace plus every live agent, including unmounted agents', () => {
    const liveAgent = agent('agent-pane');
    const hiddenAgent = agent('agent-hidden');
    const terminal = session('terminal', { cwd: '/repo/api' });
    const workspace = {
      version: 1,
      root: {
        kind: 'split',
        id: 'split',
        axis: 'horizontal',
        ratio: 0.37,
        first: { kind: 'pane', id: 'pane-agent', sessionId: liveAgent.runtimeSessionId },
        second: {
          kind: 'pane',
          id: 'pane-terminal',
          sessionId: terminal.id,
          meta: paneRecoveryMetadata(terminal),
        },
      },
      activePaneId: 'pane-terminal',
      zoomedPaneId: 'pane-agent',
    };
    const snapshot = buildRestoreSnapshot({
      windows: [
        {
          id: 'slot-1',
          groupId: 'group-1',
          activeCwd: '/repo/api',
          sessionIds: [liveAgent.runtimeSessionId, terminal.id],
          workspace,
        },
      ],
      agents: new Map([
        [liveAgent.runtimeSessionId, { info: liveAgent, session: liveAgent.session }],
        [hiddenAgent.runtimeSessionId, { info: hiddenAgent, session: hiddenAgent.session }],
      ]),
      activeWindowId: 'slot-1',
      updatedAtMs: 42,
    });

    expect(snapshot.windows[0]?.workspace).toMatchObject({
      activePaneId: 'pane-terminal',
      zoomedPaneId: 'pane-agent',
      root: { kind: 'split', ratio: 0.37 },
    });
    expect(snapshot.agents.map((entry) => entry.runtimeSessionId)).toEqual(['agent-pane', 'agent-hidden']);
    expect(snapshot.activeWindowSlotId).toBe('slot-1');
    expect(snapshotReferencedSessionIds(snapshot)).toEqual(new Set(['agent-pane', 'terminal']));
    expect(summarizeRestoreSnapshot(snapshot)).toMatchObject({ windows: 1, agents: 2, terminals: 1 });
  });

  it('collapses exited panes and repairs stale active and zoomed pane ids', () => {
    const live = session('live');
    const exited = session('exited', { exited: true });
    const document = readRestoreWorkspaceDocument({
      version: 1,
      root: {
        kind: 'split',
        id: 'split',
        axis: 'vertical',
        ratio: 0.5,
        first: { kind: 'pane', id: 'gone-pane', sessionId: exited.id, meta: paneRecoveryMetadata(exited) },
        second: { kind: 'pane', id: 'live-pane', sessionId: live.id, meta: paneRecoveryMetadata(live) },
      },
      activePaneId: 'gone-pane',
      zoomedPaneId: 'gone-pane',
    });

    expect(document).toEqual({
      version: 1,
      root: expect.objectContaining({ kind: 'pane', id: 'live-pane', sessionId: 'live' }),
      activePaneId: 'live-pane',
      zoomedPaneId: null,
    });
  });

  it('rejects an empty snapshot and strips unrecognized pane metadata to a terminal fallback', () => {
    expect(readRestoreSnapshot({ version: 2, updatedAtMs: 1, windows: [], agents: [] })).toBeUndefined();
    const parsed = readRestoreSnapshot({
      version: 2,
      updatedAtMs: 1,
      agents: [],
      windows: [
        {
          slotId: 'slot',
          groupId: 'group',
          workspace: {
            version: 1,
            root: { kind: 'pane', id: 'pane', sessionId: 'old', meta: { token: 'must-not-survive' } },
            activePaneId: 'pane',
            zoomedPaneId: null,
          },
        },
      ],
    });
    expect(parsed?.windows[0]?.workspace.root).toMatchObject({
      meta: { descriptor: { kind: 'terminal' } },
    });
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive');
  });

  it('keeps only a valid active-window reference', () => {
    const base = {
      version: 2,
      updatedAtMs: 1,
      agents: [],
      windows: [
        {
          slotId: 'slot',
          groupId: 'group',
          workspace: {
            version: 1,
            root: { kind: 'pane', id: 'pane', sessionId: 'terminal' },
            activePaneId: 'pane',
            zoomedPaneId: null,
          },
        },
      ],
    };
    expect(readRestoreSnapshot({ ...base, activeWindowSlotId: 'slot' })?.activeWindowSlotId).toBe('slot');
    expect(readRestoreSnapshot({ ...base, activeWindowSlotId: 'missing' })?.activeWindowSlotId).toBeUndefined();
  });

  it('never persists agent argv, environment, or tokens', () => {
    const info = agent('agent');
    const snapshot = buildRestoreSnapshot({
      windows: [],
      agents: new Map([
        [
          'agent',
          {
            info,
            session: info.session,
            launch: {
              kind: 'claude',
              configDir: '/profiles/claude',
              token: 'must-not-survive',
              environment: { SECRET: 'must-not-survive' },
            } as RestoreAgentLaunchProvenance,
          },
        ],
      ]),
      updatedAtMs: 1,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/argv|args|environment|token/i);
    expect(snapshot.agents[0]?.launch).toEqual({ kind: 'claude', configDir: '/profiles/claude' });
  });

  it('round-trips only an absolute Claude config root and rebuilds narrow provider options', () => {
    const info = agent('agent');
    const launch = claudeRestoreLaunchProvenance('../claude-profile', info.workspace.root);
    expect(launch).toEqual({ kind: 'claude', configDir: '/worktrees/claude-profile' });

    const metadata = paneRecoveryMetadata(info.session, info, launch);
    expect(metadata.descriptor).toMatchObject({ launch });
    if (metadata.descriptor.kind !== 'agent') throw new Error('expected agent descriptor');
    expect(restoredAgentOptions(metadata.descriptor)).toEqual({ configDir: '/worktrees/claude-profile' });

    expect(
      readRestoreDescriptor({
        ...metadata.descriptor,
        launch: { kind: 'claude', configDir: 'relative/profile' },
      }),
    ).toBeUndefined();
    expect(
      readRestoreDescriptor({
        ...metadata.descriptor,
        agent: 'codex',
      }),
    ).toBeUndefined();
  });

  it('keeps agent metadata while a restored pane is rebinding from its old id', () => {
    const recovered = agent('agent-new', 'native-agent');
    const snapshot = buildRestoreSnapshot({
      windows: [
        {
          id: 'slot',
          groupId: 'group',
          activeCwd: '/repo',
          sessionIds: ['agent-old'],
          workspace: {
            version: 1,
            root: {
              kind: 'pane',
              id: 'pane',
              sessionId: 'agent-old',
              meta: paneRecoveryMetadata(session('agent-old')),
            },
            activePaneId: 'pane',
            zoomedPaneId: null,
          },
        },
      ],
      agents: new Map([['agent-new', { info: recovered, session: recovered.session }]]),
      sessionAliases: new Map([['agent-old', 'agent-new']]),
      updatedAtMs: 1,
    });

    expect(snapshot.agents.map((entry) => entry.runtimeSessionId)).toEqual(['agent-new']);
    expect(snapshot.windows[0]?.workspace.root).toMatchObject({
      sessionId: 'agent-old',
      meta: {
        descriptor: { kind: 'agent', nativeSessionId: 'native-agent' },
      },
    });
  });

  it('keeps the shell pane but does not auto-resume an agent child that already exited', () => {
    const endedAgent = agent('agent-ended', 'native-ended');
    const snapshot = buildRestoreSnapshot({
      windows: [
        {
          id: 'slot',
          groupId: 'group',
          activeCwd: '/repo',
          sessionIds: [endedAgent.runtimeSessionId],
          workspace: {
            version: 1,
            root: {
              kind: 'pane',
              id: 'pane',
              sessionId: endedAgent.runtimeSessionId,
              meta: paneRecoveryMetadata(endedAgent.session, endedAgent),
            },
            activePaneId: 'pane',
            zoomedPaneId: null,
          },
        },
      ],
      agents: new Map([
        [endedAgent.runtimeSessionId, { info: endedAgent, session: endedAgent.session, agentProcessAlive: false }],
      ]),
      updatedAtMs: 1,
    });

    expect(snapshot.agents).toEqual([]);
    expect(snapshot.windows[0]?.workspace.root).toMatchObject({
      sessionId: endedAgent.runtimeSessionId,
      meta: { descriptor: { kind: 'terminal', cwd: '/repo' } },
    });
  });

  it('hands every mirrored pane to one shell without changing layout identity', () => {
    const agentInfo = agent('agent');
    const agentMeta = paneRecoveryMetadata(session('agent'), agentInfo);
    const workspace = {
      version: 1 as const,
      root: {
        kind: 'split' as const,
        id: 'split',
        axis: 'horizontal' as const,
        ratio: 0.35,
        first: { kind: 'pane' as const, id: 'first', sessionId: 'agent', meta: agentMeta },
        second: { kind: 'pane' as const, id: 'second', sessionId: 'agent', meta: agentMeta },
      },
      activePaneId: 'second',
      zoomedPaneId: 'second',
    };

    expect(replaceRestoreWorkspaceSession(workspace, 'agent', { id: 'shell', cwd: '/repo' })).toEqual({
      ...workspace,
      root: {
        ...workspace.root,
        first: {
          ...workspace.root.first,
          sessionId: 'shell',
          meta: paneRecoveryMetadata(session('shell')),
        },
        second: {
          ...workspace.root.second,
          sessionId: 'shell',
          meta: paneRecoveryMetadata(session('shell')),
        },
      },
    });
  });

  it('foregrounds the recorded window and uses an agent window for older V2 snapshots', () => {
    const info = agent('agent');
    const agentPane = paneRecoveryMetadata(info.session, info);
    if (agentPane.descriptor.kind !== 'agent') throw new Error('expected agent descriptor');
    const terminalPane = paneRecoveryMetadata(session('terminal'));
    const windows = [
      {
        slotId: 'agent-slot',
        groupId: 'agent-group',
        workspace: {
          version: 1 as const,
          root: { kind: 'pane' as const, id: 'agent-pane', sessionId: 'agent', meta: agentPane },
          activePaneId: 'agent-pane',
          zoomedPaneId: null,
        },
      },
      {
        slotId: 'terminal-slot',
        groupId: 'terminal-group',
        workspace: {
          version: 1 as const,
          root: { kind: 'pane' as const, id: 'terminal-pane', sessionId: 'terminal', meta: terminalPane },
          activePaneId: 'terminal-pane',
          zoomedPaneId: null,
        },
      },
    ];
    const base = {
      version: 2 as const,
      updatedAtMs: 1,
      windows,
      agents: [{ runtimeSessionId: 'agent', ...agentPane.descriptor }],
    };

    expect(preferredRestoreWindow({ ...base, activeWindowSlotId: 'terminal-slot' })?.slotId).toBe('terminal-slot');
    expect(preferredRestoreWindow(base)?.slotId).toBe('agent-slot');
  });
});
