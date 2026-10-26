import { describe, expect, it } from 'vitest';
import { agentEventType, safeParseAgentEvent } from '@vibefield/puppeteer-core';
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
      expect(safeParseAgentEvent(agentEventType(event), event).success).toBe(true);
    }
  });

  it('fails a declined command: it never ran, so it has no output to complete with', () => {
    // The item/completed the hermetic approval-decline census captures (0.150.0 and 0.164.0).
    const declined = new CodexToolNormalizer().normalize({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'cmd-declined',
          command: '<redacted:command>',
          cwd: '/workspace',
          processId: null,
          source: 'agent',
          status: 'declined',
          commandActions: [{ type: 'unknown', command: '<redacted:command>' }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    }).events;

    expect(declined).toEqual([
      expect.objectContaining({
        type: 'tool:failed',
        toolCallId: 'cmd-declined',
        tool: 'command',
        error: 'command was declined',
        presentation: expect.objectContaining({ title: 'Command declined' }),
      }),
    ]);
    expect(safeParseAgentEvent(agentEventType(declined[0]!), declined[0]).success).toBe(true);
  });

  it('completes a command that exited 0, and fails one that exited non-zero without a status', () => {
    const normalizer = new CodexToolNormalizer();
    const completed = (item: Record<string, unknown>) =>
      normalizer.normalize({ method: 'item/completed', params: { item: { type: 'commandExecution', ...item } } })
        .events[0];
    expect(completed({ id: 'ok', status: 'completed', exitCode: 0, aggregatedOutput: 'ok\n' })).toMatchObject({
      type: 'tool:completed',
      output: 'ok\n',
    });
    expect(completed({ id: 'exit', exitCode: 2 })).toMatchObject({
      type: 'tool:failed',
      error: 'command exited with status 2',
    });
  });
});
