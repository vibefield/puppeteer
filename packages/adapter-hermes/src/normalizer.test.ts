import { describe, expect, it } from 'vitest';
import { HermesGatewayNormalizer } from './normalizer.js';

function event(type: string, payload: Record<string, unknown> = {}, sessionId = 'abcd1234') {
  return { jsonrpc: '2.0', method: 'event', params: { type, session_id: sessionId, payload } };
}

describe('HermesGatewayNormalizer', () => {
  it('maps a no-tool turn without treating spinner text as reasoning', () => {
    const normalizer = new HermesGatewayNormalizer();
    normalizer.bindStoredSession('abcd1234', '20260812_132919_ae981b');
    const events = [
      event('gateway.ready'),
      event('session.info', {
        model: 'chopsticks-hermes-census',
        stored_session_id: '20260812_132919_ae981b',
        cwd: '/workspace',
        running: false,
      }),
      event('message.start'),
      event('thinking.delta', { text: '(⊙_⊙) pondering...' }),
      event('message.delta', { text: 'SURFACE_' }),
      event('message.delta', { text: 'HERMES_OK' }),
      event('reasoning.available', { text: 'SURFACE_HERMES_OK' }),
      event('message.complete', { text: 'SURFACE_HERMES_OK', status: 'complete' }),
    ].flatMap((frame) => normalizer.normalize(frame).events);

    expect(events.map((item) => item.type)).toEqual([
      'adapter.native-event',
      'session.started',
      'session.ready',
      'session.environment.updated',
      'turn.started',
      'adapter.native-event',
      'assistant.message',
      'assistant.message',
      'adapter.native-event',
      'assistant.message',
      'turn.completed',
    ]);
    expect(events.find((item) => item.type === 'session.started')).toMatchObject({
      nativeSessionId: '20260812_132919_ae981b',
    });
    expect(events.filter((item) => item.type === 'assistant.message').at(-1)).toMatchObject({
      text: 'SURFACE_HERMES_OK',
      final: true,
    });
    expect(events.some((item) => item.type.startsWith('reasoning.'))).toBe(false);
  });

  it('maps tools and native-TUI approvals without inventing a resolution', () => {
    const normalizer = new HermesGatewayNormalizer();
    const success = [
      event('tool.start', { name: 'terminal', tool_id: 'call_1' }),
      event('tool.complete', { name: 'terminal', tool_id: 'call_1', result: { exit_code: 0, output: 'ok' } }),
    ].flatMap((frame) => normalizer.normalize(frame).events);
    expect(success).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool.requested', tool: 'terminal', toolCallId: 'call_1' }),
        expect.objectContaining({ type: 'tool.completed', toolCallId: 'call_1' }),
      ]),
    );

    const denied = new HermesGatewayNormalizer();
    const permission = denied.normalize(
      event('approval.request', { name: 'terminal', tool_id: 'call_rm', choices: ['once', 'deny'] }),
    ).events;
    expect(permission).toEqual([
      expect.objectContaining({
        type: 'permission.requested',
        requestId: 'call_rm',
        presentation: 'native-tui',
      }),
    ]);
    expect(
      denied.normalize(
        event('tool.complete', { name: 'terminal', tool_id: 'call_rm', result: { status: 'blocked', exit_code: -1 } }),
      ).events,
    ).toEqual([expect.objectContaining({ type: 'tool.failed', toolCallId: 'call_rm' })]);
    expect(
      denied
        .normalize(event('tool.complete', { name: 'terminal', tool_id: 'call_rm', result: { status: 'blocked' } }))
        .events.some((item) => item.type === 'permission.resolved'),
    ).toBe(false);
  });

  it('acknowledges a created session without inventing a second start', () => {
    const normalizer = new HermesGatewayNormalizer();
    const first = normalizer.acknowledgeSession('20260812_132919_ae981b');
    expect(first.events).toEqual([
      { type: 'session.started', nativeSessionId: '20260812_132919_ae981b' },
      { type: 'session.ready' },
    ]);
    expect(normalizer.acknowledgeSession('20260812_132919_ae981b').events).toEqual([]);
    expect(
      normalizer.normalize(
        event('session.info', {
          model: 'chopsticks-hermes-census',
          stored_session_id: '20260812_132919_ae981b',
          cwd: '/workspace',
          running: false,
        }),
      ).events,
    ).toEqual([expect.objectContaining({ type: 'session.environment.updated', currentCwd: '/workspace' })]);
  });

  it('marks interrupted completion as turn.failed', () => {
    const normalizer = new HermesGatewayNormalizer();
    normalizer.normalize(event('message.start'));
    const events = normalizer.normalize(event('message.complete', { text: 'partial', status: 'interrupted' })).events;
    expect(events).toEqual([
      expect.objectContaining({ type: 'assistant.message', final: true, text: 'partial' }),
      expect.objectContaining({ type: 'turn.failed', error: 'interrupted' }),
    ]);
  });

  it('uses the provider context gauge rather than cumulative token usage', () => {
    const normalizer = new HermesGatewayNormalizer();
    const events = normalizer.normalize(
      event('session.info', {
        model: 'model-a',
        usage: {
          total: 9_999,
          context_used: 250,
          context_max: 1_000,
          context_percent: 24.5,
        },
      }),
    ).events;

    expect(events).toContainEqual({
      type: 'context-window.updated',
      usedTokens: 250,
      capacityTokens: 1_000,
      usedPercentage: 24.5,
      percentageSource: 'provider',
      modelId: 'model-a',
    });
    expect(
      normalizer.normalize(event('session.info', { usage: { total: 10_100, context_max: 1_000 } })).events,
    ).not.toContainEqual(expect.objectContaining({ type: 'context-window.updated' }));
  });

  it('detects native option questions and cancellation without terminal parsing', () => {
    const normalizer = new HermesGatewayNormalizer();
    const request = event('clarify.request', {
      request_id: 'clarify-1',
      question: 'Which release lane?',
      choices: ['Canary', 'Stable'],
      multi_select: false,
    });

    expect(normalizer.normalize(request).events).toEqual([
      {
        type: 'question.requested',
        requestId: 'clarify-1',
        questions: [
          {
            id: 'clarify-1',
            prompt: 'Which release lane?',
            options: [{ label: 'Canary' }, { label: 'Stable' }],
            allowMultiple: false,
            allowFreeForm: true,
          },
        ],
      },
    ]);
    expect(normalizer.normalize(request).events).toEqual([]);
    expect(normalizer.normalize(event('clarify.expire', { request_id: 'clarify-1' })).events).toEqual([
      { type: 'question.resolved', requestId: 'clarify-1', outcome: 'cancelled' },
    ]);
    expect(normalizer.normalize(event('clarify.expire', { request_id: 'clarify-1' })).events).toEqual([]);
  });
});
