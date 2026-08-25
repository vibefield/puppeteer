import { describe, expect, it } from 'vitest';
import type { AgentMonitorState } from './types.js';
import { isMonitorStateAfterRemoval, isNewerMonitorRevision } from './ordering.js';

describe('monitor revision ordering', () => {
  it('orders revisions within an epoch and epochs across reconstruction', () => {
    expect(isNewerMonitorRevision({ runtimeEpoch: 2, revision: 8 }, { runtimeEpoch: 2, revision: 7 })).toBe(true);
    expect(isNewerMonitorRevision({ runtimeEpoch: 2, revision: 6 }, { runtimeEpoch: 2, revision: 7 })).toBe(false);
    expect(isNewerMonitorRevision({ runtimeEpoch: 3, revision: 1 }, { runtimeEpoch: 2, revision: 99 })).toBe(true);
  });

  it('does not revive a removed run without an explicitly newer epoch', () => {
    const state = { runtimeEpoch: 2 } as AgentMonitorState;
    expect(isMonitorStateAfterRemoval(state, 2)).toBe(false);
    expect(isMonitorStateAfterRemoval(state, 3)).toBe(false);
    expect(isMonitorStateAfterRemoval(state, null)).toBe(false);
    expect(isMonitorStateAfterRemoval({ ...state, runtimeEpoch: 3 }, 2)).toBe(true);
  });
});
