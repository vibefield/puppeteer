import { describe, expect, it } from 'vitest';
import { CopilotSessionNormalizer } from './pipeline.js';

const record = (type: string, data: Record<string, unknown>, id = type) => ({
  type,
  data,
  id,
  parentId: null,
  timestamp: '2026-08-25T00:00:00Z',
});
describe('Copilot session normalization', () => {
  it('collapses model response cycles into one user interaction turn', () => {
    const normalizer = new CopilotSessionNormalizer();
    expect(
      normalizer.normalize(record('user.message', { content: 'run it', interactionId: 'interaction' })).events[0],
    ).toEqual({ type: 'turn:started', turnId: 'interaction', prompt: 'run it' });
    normalizer.normalize(record('assistant.turn_start', { turnId: '0', interactionId: 'interaction' }));
    const request = normalizer.normalize(
      record('assistant.message', {
        turnId: '0',
        interactionId: 'interaction',
        content: '',
        toolRequests: [{ toolCallId: 'call', name: 'bash', arguments: { command: 'echo ok' } }],
        outputTokens: 2,
      }),
    );
    expect(request.events.map((event) => event.type)).toEqual(['tool:requested']);
    expect(normalizer.normalize(record('assistant.turn_end', { turnId: '0' })).events).toEqual([]);
    normalizer.normalize(record('assistant.turn_start', { turnId: '1', interactionId: 'interaction' }));
    normalizer.normalize(
      record('assistant.message', { turnId: '1', interactionId: 'interaction', content: 'done', toolRequests: [] }),
    );
    expect(normalizer.normalize(record('assistant.turn_end', { turnId: '1' })).events.at(-1)).toEqual({
      type: 'turn:completed',
      turnId: 'interaction',
    });
  });
  it('maps native workspace file changes directly', () => {
    expect(
      new CopilotSessionNormalizer().normalize(
        record('session.workspace_file_changed', { path: 'a.ts', operation: 'modified' }),
      ).events,
    ).toEqual([{ type: 'workspace:file-changed', changes: [{ path: 'a.ts', kind: 'modify' }] }]);
  });
  it('retains plan mutations on the native rail without a portable plan', () => {
    const nativeEvent = record('session.plan_changed', { operation: 'write' });
    expect(new CopilotSessionNormalizer().normalize(nativeEvent)).toMatchObject({
      disposition: 'retained-native',
      nativeEvent,
      events: [{ type: 'adapter:native-event', adapter: 'copilot', nativeType: 'session.plan_changed' }],
    });
  });
  it('projects effective model and effort from the session header', () => {
    expect(
      new CopilotSessionNormalizer().normalize(
        record('session.start', {
          sessionId: 'session-1',
          context: { cwd: '/repo' },
          selectedModel: 'gpt-5',
          reasoningEffort: 'high',
        }),
      ).events,
    ).toEqual([
      { type: 'session:started', nativeSessionId: 'session-1', startSource: 'session.start' },
      { type: 'environment:updated', currentCwd: '/repo' },
      { type: 'model:updated', intent: 'observed', model: { id: 'gpt-5' } },
      { type: 'effort:updated', intent: 'observed', effort: 'high' },
    ]);
  });
  it('does not invalidate context after a failed compaction', () => {
    expect(
      new CopilotSessionNormalizer().normalize(record('session.compaction_complete', { success: false })).events,
    ).toEqual([{ type: 'compaction:completed', outcome: 'failed' }]);
  });
  it('retains shutdown metadata without turning transcript totals into live usage', () => {
    const events = new CopilotSessionNormalizer().normalize(
      record('session.shutdown', {
        modelMetrics: {
          'gpt-5': {
            usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, reasoningTokens: 2 },
          },
        },
      }),
    ).events;
    expect(events).toEqual([
      {
        type: 'adapter:native-event',
        adapter: 'copilot',
        nativeType: 'session.shutdown',
      },
    ]);
  });
  it('keeps root and subagent turn correlation independent', () => {
    const normalizer = new CopilotSessionNormalizer();
    normalizer.normalize(record('user.message', { interactionId: 'root', content: 'root' }, 'root-user'));
    normalizer.normalize({
      ...record('user.message', { interactionId: 'child', content: 'child' }, 'child-user'),
      agentId: 'child-1',
    });
    normalizer.normalize({ ...record('assistant.turn_start', { turnId: '0' }), agentId: 'child-1' });
    normalizer.normalize({
      ...record('assistant.message', {
        turnId: '0',
        content: 'child reply',
        messageId: 'child-message',
        toolRequests: [],
      }),
      agentId: 'child-1',
    });
    expect(
      normalizer.normalize({ ...record('assistant.turn_end', { turnId: '0' }), agentId: 'child-1' }).events,
    ).toEqual([{ type: 'turn:completed', turnId: 'child' }]);
    normalizer.normalize(record('assistant.turn_start', { turnId: '0' }));
    normalizer.normalize(
      record('assistant.message', {
        turnId: '0',
        content: 'root reply',
        messageId: 'root-message',
        toolRequests: [],
      }),
    );
    expect(normalizer.normalize(record('assistant.turn_end', { turnId: '0' })).events).toEqual([
      { type: 'turn:completed', turnId: 'root' },
    ]);
  });
});
