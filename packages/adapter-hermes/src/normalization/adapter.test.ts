import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HermesGatewayNormalizer } from './pipeline.js';

/** The sanitized 0.21.5 census stream (Surface evidence), one native JSON-RPC frame per line. */
function census(scenario: string): Record<string, unknown>[] {
  const path = fileURLToPath(
    new URL(`../../../surface/vendors/hermes/captures/hermes@0.21.5/${scenario}/rpc.jsonl`, import.meta.url),
  );
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((frame) => frame.direction !== 'client');
}

function serverRequest(id: string, method: string, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, method, params: { session_id: 'abcd1234', ...params } };
}

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
        model: 'puppeteer-hermes-census',
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
      'adapter:native-event',
      'session:started',
      'session:ready',
      'environment:updated',
      'model:updated',
      'turn:started',
      'adapter:native-event',
      'conversation:assistant-message',
      'conversation:assistant-message',
      'adapter:native-event',
      'conversation:assistant-message',
      'turn:completed',
    ]);
    expect(events.find((item) => item.type === 'session:started')).toMatchObject({
      nativeSessionId: '20260812_132919_ae981b',
    });
    expect(events.filter((item) => item.type === 'conversation:assistant-message').at(-1)).toMatchObject({
      text: 'SURFACE_HERMES_OK',
      final: true,
    });
    expect(events.some((item) => item.type.startsWith('reasoning:'))).toBe(false);
  });

  it('maps tools and native-TUI approvals without inventing a resolution', () => {
    const normalizer = new HermesGatewayNormalizer();
    const success = [
      event('tool.start', { name: 'terminal', tool_id: 'call_1' }),
      event('tool.complete', { name: 'terminal', tool_id: 'call_1', result: { exit_code: 0, output: 'ok' } }),
    ].flatMap((frame) => normalizer.normalize(frame).events);
    expect(success).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool:requested', tool: 'terminal', toolCallId: 'call_1' }),
        expect.objectContaining({ type: 'tool:completed', toolCallId: 'call_1' }),
      ]),
    );

    const denied = new HermesGatewayNormalizer();
    const permission = denied.normalize(
      event('approval.request', { name: 'terminal', tool_id: 'call_rm', choices: ['once', 'deny'] }),
    ).events;
    expect(permission).toEqual([
      expect.objectContaining({
        type: 'interaction:permission-requested',
        requestId: 'call_rm',
        presentation: 'native-tui',
      }),
    ]);
    expect(
      denied.normalize(
        event('tool.complete', { name: 'terminal', tool_id: 'call_rm', result: { status: 'blocked', exit_code: -1 } }),
      ).events,
    ).toEqual([expect.objectContaining({ type: 'tool:failed', toolCallId: 'call_rm' })]);
    expect(
      denied
        .normalize(event('tool.complete', { name: 'terminal', tool_id: 'call_rm', result: { status: 'blocked' } }))
        .events.some((item) => item.type === 'interaction:permission-resolved'),
    ).toBe(false);
  });

  it('acknowledges a created session without inventing a second start', () => {
    const normalizer = new HermesGatewayNormalizer();
    const first = normalizer.acknowledgeSession('20260812_132919_ae981b');
    expect(first.events).toEqual([
      { type: 'session:started', nativeSessionId: '20260812_132919_ae981b' },
      { type: 'session:ready' },
    ]);
    expect(normalizer.acknowledgeSession('20260812_132919_ae981b').events).toEqual([]);
    expect(
      normalizer.normalize(
        event('session.info', {
          model: 'puppeteer-hermes-census',
          stored_session_id: '20260812_132919_ae981b',
          cwd: '/workspace',
          running: false,
        }),
      ).events,
    ).toEqual([
      expect.objectContaining({ type: 'environment:updated', currentCwd: '/workspace' }),
      expect.objectContaining({ type: 'model:updated', model: { id: 'puppeteer-hermes-census' } }),
    ]);
  });

  it('marks interrupted completion as turn:failed', () => {
    const normalizer = new HermesGatewayNormalizer();
    normalizer.normalize(event('message.start'));
    const events = normalizer.normalize(event('message.complete', { text: 'partial', status: 'interrupted' })).events;
    expect(events).toEqual([
      expect.objectContaining({ type: 'conversation:assistant-message', final: true, text: 'partial' }),
      expect.objectContaining({ type: 'turn:failed', error: 'interrupted' }),
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
      type: 'context-window:updated',
      usedTokens: 250,
      capacityTokens: 1_000,
      usedPercentage: 24.5,
      percentageSource: 'provider',
      modelId: 'model-a',
    });
    expect(
      normalizer.normalize(event('session.info', { usage: { total: 10_100, context_max: 1_000 } })).events,
    ).not.toContainEqual(expect.objectContaining({ type: 'context-window:updated' }));
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
        type: 'interaction:question-requested',
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
      { type: 'interaction:question-resolved', requestId: 'clarify-1', outcome: 'cancelled' },
    ]);
    expect(normalizer.normalize(event('clarify.expire', { request_id: 'clarify-1' })).events).toEqual([]);
  });

  it('opens a native-TUI permission from the 0.21.5 approval server request in the captured deny turn', () => {
    const normalizer = new HermesGatewayNormalizer();
    const frames = census('permission-deny');
    const approval = frames.find((frame) => frame.method === 'approval') as { params: { request_id: string } };
    const events = frames.flatMap((frame) => normalizer.normalize(frame).events);

    expect(events.filter((item) => item.type.startsWith('interaction:'))).toEqual([
      {
        type: 'interaction:permission-requested',
        requestId: approval.params.request_id,
        tool: 'terminal',
        presentation: 'native-tui',
      },
    ]);
    const types = events.map((item) => item.type);
    expect(types.indexOf('tool:requested')).toBeLessThan(types.indexOf('interaction:permission-requested'));
    expect(types.indexOf('interaction:permission-requested')).toBeLessThan(types.indexOf('tool:failed'));
    expect(types).toContain('turn:completed');
  });

  it('closes a server-request permission only when Hermes withdraws it', () => {
    const normalizer = new HermesGatewayNormalizer();
    const request = serverRequest('srq-0123456789ab', 'approval', {
      request_id: 'approval-1',
      command: 'rm -rf ./scratch',
      choices: ['once', 'session', 'always', 'deny'],
    });
    expect(normalizer.normalize(request).events).toHaveLength(1);
    expect(normalizer.normalize(request).events).toEqual([]);
    expect(
      normalizer.normalize(event('request.cancel', { id: 'srq-0123456789ab', method: 'approval', reason: 'timeout' }))
        .events,
    ).toEqual([{ type: 'interaction:permission-resolved', requestId: 'approval-1', outcome: 'dismissed' }]);
    expect(
      normalizer.normalize(event('request.cancel', { id: 'srq-0123456789ab', method: 'approval', reason: 'timeout' })),
    ).toMatchObject({
      disposition: 'retained-native',
      events: [{ type: 'adapter:native-event', nativeType: 'request.cancel' }],
    });
  });

  it('asks single and batch 0.21.5 clarify server requests and cancels them by srq id', () => {
    const normalizer = new HermesGatewayNormalizer();
    expect(
      normalizer.normalize(
        serverRequest('srq-00000000000a', 'clarify', {
          question: 'Which release lane?',
          choices: ['Canary', 'Stable'],
        }),
      ).events,
    ).toEqual([
      {
        type: 'interaction:question-requested',
        requestId: 'srq-00000000000a',
        questions: [
          {
            prompt: 'Which release lane?',
            options: [{ label: 'Canary' }, { label: 'Stable' }],
            allowMultiple: false,
            allowFreeForm: true,
          },
        ],
      },
    ]);
    expect(
      normalizer.normalize(
        serverRequest('srq-00000000000b', 'clarify', {
          questions: [
            { qid: 'q1', question: 'Name?', multi_select: false },
            { qid: 'q2', question: 'Targets?', choices: ['a', 'b'], multi_select: true },
          ],
        }),
      ).events,
    ).toEqual([
      expect.objectContaining({
        requestId: 'srq-00000000000b',
        questions: [
          expect.objectContaining({ id: 'q1', prompt: 'Name?', allowMultiple: false }),
          expect.objectContaining({ id: 'q2', prompt: 'Targets?', allowMultiple: true }),
        ],
      }),
    ]);
    expect(
      normalizer.normalize(
        event('request.cancel', { id: 'srq-00000000000a', method: 'clarify', reason: 'interrupted' }),
      ).events,
    ).toEqual([{ type: 'interaction:question-resolved', requestId: 'srq-00000000000a', outcome: 'cancelled' }]);
  });

  it('retains server requests it does not interpret as native events', () => {
    const normalizer = new HermesGatewayNormalizer();
    expect(normalizer.normalize(serverRequest('srq-00000000000c', 'sudo', {}))).toMatchObject({
      disposition: 'retained-native',
      events: [{ type: 'adapter:native-event', adapter: 'hermes', nativeType: 'sudo' }],
    });
  });
});
