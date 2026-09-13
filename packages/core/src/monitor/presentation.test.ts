import { describe, expect, it } from 'vitest';
import type { AgentMonitorState } from './types.js';
import { monitorBlockerDetail, presentAgentMonitorHeadline } from './presentation.js';

function state(overrides: Partial<AgentMonitorState> = {}): AgentMonitorState {
  return {
    schemaVersion: 1,
    runtimeRunId: 'run-1',
    runtimeEpoch: 1,
    revision: 1,
    status: 'idle',
    statusSince: '2026-08-17T00:00:00.000Z',
    blockers: [],
    usage: { samples: [] },
    modes: { execution: 'native-tui' },
    subagentCount: 0,
    subagents: [],

    compaction: { active: false, count: 0 },
    environment: { worktrees: [] },
    session: {},
    freshness: { level: 'native-hooks', families: {} },
    alive: true,
    ...overrides,
  };
}

describe('monitor presentation', () => {
  it('copies the three-state headline and projected activity without reclassification', () => {
    expect(presentAgentMonitorHeadline(state())).toMatchObject({ status: 'idle', label: 'Idle', detail: 'idle' });
    expect(
      presentAgentMonitorHeadline(
        state({
          status: 'working',
          activity: { kind: 'tool', line: 'Editing monitor.ts', since: '2026-08-17T00:01:00.000Z' },
        }),
      ),
    ).toMatchObject({ status: 'working', label: 'Working', detail: 'Editing monitor.ts' });
  });

  it('keeps permission, structured question, and failure details distinct', () => {
    expect(
      monitorBlockerDetail({
        id: 'permission-1',
        kind: 'permission',
        since: '2026-08-17T00:00:00.000Z',
        permission: { requestId: 'request-1', tool: 'Bash' },
      }),
    ).toBe('permission · Bash');
    expect(
      monitorBlockerDetail({
        id: 'question-1',
        kind: 'question',
        since: '2026-08-17T00:00:00.000Z',
        questions: [{ header: 'Database', prompt: 'Choose one', options: [{ label: 'SQLite' }] }],
      }),
    ).toBe('question · Database');
    expect(
      monitorBlockerDetail({
        id: 'failure-1',
        kind: 'failure',
        since: '2026-08-17T00:00:00.000Z',
        failure: { code: 'PROCESS_DIED' },
      }),
    ).toBe('failure · PROCESS_DIED');
  });

  it('trusts reducer blocker priority and reports simultaneous blocker count', () => {
    const projected = presentAgentMonitorHeadline(
      state({
        status: 'blocked',
        blockers: [
          {
            id: 'question-1',
            kind: 'question',
            since: '2026-08-17T00:00:00.000Z',
            questions: [{ prompt: 'Choose one' }],
          },
          { id: 'failure-1', kind: 'failure', since: '2026-08-17T00:00:01.000Z' },
        ],
      }),
    );
    expect(projected).toMatchObject({ status: 'blocked', detail: 'question · Choose one', blockerCount: 2 });
    expect(presentAgentMonitorHeadline(state({ status: 'blocked' }))).toMatchObject({
      status: 'blocked',
      detail: 'blocked',
    });
  });
});
