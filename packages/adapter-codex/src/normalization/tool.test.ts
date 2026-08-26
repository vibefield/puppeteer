import { describe, expect, it } from 'vitest';
import { agentServiceEventType, safeParseAgentEvent } from '@vibecook/puppeteer-core';
import { CodexToolNormalizer } from './tool.js';

describe('CodexToolNormalizer', () => {
  it('emits schema-valid command lifecycle events', () => {
    const normalizer = new CodexToolNormalizer();
    const started = normalizer.normalize({
      method: 'item/started',
      params: { item: { type: 'commandExecution', id: 'cmd-1', command: ['pnpm', 'test'] } },
    }).events;
    const failed = normalizer.normalize({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: ['pnpm', 'test'],
          status: 'failed',
          exitCode: 1,
          aggregatedOutput: 'failure details remain native evidence',
        },
      },
    }).events;
    const events = [...started, ...failed];

    expect(events).toMatchObject([
      { type: 'tool:started', toolCallId: 'cmd-1' },
      { type: 'tool:failed', toolCallId: 'cmd-1' },
    ]);
    expect(failed[0]).not.toHaveProperty('output');
    for (const event of events) {
      expect(safeParseAgentEvent(agentServiceEventType(event), event).success).toBe(true);
    }
  });
});
