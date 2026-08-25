import { describe, expect, it } from 'vitest';
import { createInitialSessionState } from '@vibecook/chopsticks-core';
import { serializeLegacySessionState } from './legacy-state-bridge.js';

describe('legacy renderer state bridge', () => {
  it('isolates the v1 JSON conversion and omits private reducer tombstones', () => {
    const state = {
      ...createInitialSessionState(),
      lifecycle: 'running' as const,
      tools: new Map([['tool-1', { toolCallId: 'tool-1', tool: 'Bash', state: 'running' as const }]]),
      settledTools: new Map([['old-tool', 'completed' as const]]),
      permissions: new Map([['permission-1', { requestId: 'permission-1', tool: 'Bash' }]]),
      subagents: new Map([['child-1', { subagentId: 'child-1', agentType: 'researcher' }]]),
      tasks: new Map([['task-1', { taskId: 'task-1', description: 'Verify cutover' }]]),
      lastSequence: 9,
    };

    const serialized = serializeLegacySessionState(state);
    expect(serialized).toMatchObject({
      lifecycle: 'running',
      tools: [{ toolCallId: 'tool-1', tool: 'Bash', state: 'running' }],
      permissions: [{ requestId: 'permission-1', tool: 'Bash' }],
      subagents: [{ subagentId: 'child-1', agentType: 'researcher' }],
      tasks: [{ taskId: 'task-1', description: 'Verify cutover' }],
      lastSequence: 9,
    });
    expect(serialized).not.toHaveProperty('settledTools');
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });
});
