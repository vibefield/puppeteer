import { describe, expect, it } from 'vitest';
import { PiSessionNormalizer } from './pipeline.js';

describe('Pi session normalization', () => {
  it('maps a tool turn, usage, and workspace edit without terminal inference', () => {
    const normalizer = new PiSessionNormalizer();
    expect(
      normalizer
        .normalize({ type: 'session', id: 's', timestamp: '2026-08-25T00:00:00Z', cwd: '/work' })
        .events.map((event) => event.type),
    ).toEqual(['session:started', 'environment:updated']);
    expect(
      normalizer.normalize({
        type: 'message',
        id: 'u',
        timestamp: '2026-08-25T00:00:01Z',
        message: { role: 'user', content: [{ type: 'text', text: 'edit it' }] },
      }).events,
    ).toContainEqual({ type: 'turn:started', turnId: 'u', prompt: 'edit it' });
    const request = normalizer.normalize({
      type: 'message',
      id: 'a1',
      timestamp: '2026-08-25T00:00:02Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'invalid-without-name', arguments: { path: 'wrong.ts' } },
          { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'a.ts', oldText: 'a', newText: 'b' } },
        ],
        stopReason: 'toolUse',
        usage: { input: 4, output: 2, totalTokens: 6 },
      },
    });
    expect(request.events.map((event) => event.type)).toEqual([
      'tool:requested',
      'workspace:file-operation',
      'usage:tokens-used',
    ]);
    const result = normalizer.normalize({
      type: 'message',
      id: 'r',
      timestamp: '2026-08-25T00:00:03Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'edit',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      },
    });
    expect(result.events.map((event) => event.type)).toEqual(['tool:completed', 'workspace:file-operation']);
    const done = normalizer.normalize({
      type: 'message',
      id: 'a2',
      timestamp: '2026-08-25T00:00:04Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' },
    });
    expect(done.events.map((event) => event.type)).toEqual(['conversation:assistant-message', 'turn:completed']);
  });

  it('maps compaction as a completed durable boundary', () => {
    const events = new PiSessionNormalizer().normalize({
      type: 'compaction',
      id: 'c',
      timestamp: '2026-08-25T00:00:00Z',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { total: 0.01 },
      },
    }).events;
    expect(events.map((event) => event.type)).toEqual([
      'usage:tokens-used',
      'context-window:invalidated',
      'compaction:completed',
    ]);
    expect(events[0]).toMatchObject({ totalTokens: 18, meterTokens: 15 });
  });
});
