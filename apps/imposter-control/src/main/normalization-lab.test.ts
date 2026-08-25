import { describe, expect, it } from 'vitest';
import type { EmittedEntry, SessionView } from '@vibecook/puppeteer-imposter/control';
import { IDLE_SCENARIO_DRIVER } from './testing.js';
import {
  createNormalizationLab,
  NORMALIZATION_WINDOW_RECORDS,
  type NormalizationSnapshot,
  type NormalizationUpdate,
} from './normalization-lab.js';

function emitted(
  sequence: number,
  event: string,
  payload: Record<string, unknown> = {},
  channel?: string,
): EmittedEntry {
  return {
    at: new Date(Date.UTC(2026, 7, 9) + sequence * 1_000).toISOString(),
    sequence,
    event,
    payload,
    ...(channel ? { channel } : {}),
  };
}

function session(
  vendor: string,
  events: Array<{
    event: string;
    transport?:
      | 'hook'
      | 'jsonrpc-notification'
      | 'jsonrpc-request'
      | 'jsonl-record'
      | 'command-stdin'
      | 'json-file'
      | 'sse-event';
  }>,
): SessionView {
  const defaultChannel =
    vendor === 'claude'
      ? 'hooks'
      : vendor === 'kimi'
        ? 'wire'
        : vendor === 'opencode'
          ? 'sse'
          : vendor === 'hermes'
            ? 'tui-gateway'
            : 'jsonrpc';
  const channelFor = (transport: (typeof events)[number]['transport']): string => {
    if (transport === 'command-stdin') return 'hook-command';
    if (transport === 'json-file') return 'session-state';
    return defaultChannel;
  };
  return {
    vendor,
    version: 'test',
    sessionId: `${vendor}-session`,
    pid: 42,
    cwd: '/work',
    channels: vendor === 'kimi' ? ['wire', 'hook-command', 'session-state'] : [defaultChannel],
    nativeBehavior: {
      behaviorVersion: 1,
      title: `${vendor} test surface`,
      lanes: [{ id: 'session', label: 'Session' }],
      nodes: events.map((descriptor, order) => ({
        id: `event-${order}`,
        event: descriptor.event,
        confidence: 'verified-headless',
        lane: 'session',
        order,
      })),
      relations: [],
    },
    nativeEvents: events.map((descriptor) => ({
      event: descriptor.event,
      fields: [],
      channel: channelFor(descriptor.transport),
      channels: [channelFor(descriptor.transport)],
      confidence: 'verified-headless',
      ...(descriptor.transport ? { transport: descriptor.transport } : {}),
    })),
    ops: [],
    runflows: [],
    scenarioDriver: IDLE_SCENARIO_DRIVER,
    joinedAt: '2026-08-09T00:00:00.000Z',
  };
}

describe('normalization lab projection', () => {
  it('replays Claude records in native sequence order into deterministic Core state', () => {
    const view = session('claude', [
      { event: 'SessionStart', transport: 'hook' },
      { event: 'UserPromptSubmit', transport: 'hook' },
      { event: 'PreToolUse', transport: 'hook' },
      { event: 'PostToolUse', transport: 'hook' },
      { event: 'Stop', transport: 'hook' },
      { event: 'FutureHook', transport: 'hook' },
    ]);
    const records = [
      emitted(5, 'Stop', { prompt_id: 'prompt-1', last_assistant_message: 'done' }),
      emitted(1, 'SessionStart', { session_id: view.sessionId, cwd: '/work' }),
      emitted(4, 'PostToolUse', {
        prompt_id: 'prompt-1',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        tool_response: { output: 'ok' },
      }),
      emitted(2, 'UserPromptSubmit', { prompt_id: 'prompt-1', prompt: 'hello' }),
      emitted(3, 'PreToolUse', {
        prompt_id: 'prompt-1',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
    ];
    const lab = createNormalizationLab();
    lab.join(view);

    const first = lab.synchronize(view, records) as NormalizationSnapshot;
    const replayed = lab.synchronize(view, [...records].reverse()) as NormalizationSnapshot;

    expect(replayed).toEqual(first);
    expect(first.traces.map((trace) => trace.nativeSequence)).toEqual([1, 2, 3, 4, 5]);
    expect(first.traces.map((trace) => trace.disposition)).toEqual(['mapped', 'mapped', 'mapped', 'mapped', 'mapped']);
    expect(first.traces[2]!.events.map((event) => event.event.type)).toEqual(['tool.requested']);
    expect(first.traces[2]!.changes.some((change) => change.path === 'tools')).toBe(true);
    expect(first.state).toMatchObject({
      lifecycle: 'ready',
      lastAssistantMessage: 'done',
      counters: { toolsCompleted: 1, toolsFailed: 0, unknownEvents: 0 },
      tools: [],
    });

    const update = lab.ingest(view, emitted(6, 'FutureHook', { future: true })) as NormalizationUpdate;
    expect(update.fromNativeSequence).toBe(6);
    expect(update.traces).toHaveLength(1);
    expect(update.traces[0]).toMatchObject({ disposition: 'retained-native' });
    expect(update.traces[0]!.events[0]!.event).toMatchObject({
      type: 'adapter.native-event',
      nativeType: 'FutureHook',
    });
    expect(update.state).toMatchObject({ counters: { unknownEvents: 1 } });
    expect(lab.ingest(view, emitted(6, 'FutureHook', { duplicate: true }))).toBeUndefined();

    const lateLab = createNormalizationLab();
    lateLab.join(view);
    lateLab.ingest(
      view,
      records.find((record) => record.sequence === 1)!,
    );
    lateLab.ingest(
      view,
      records.find((record) => record.sequence === 5)!,
    );
    const corrected = lateLab.ingest(
      view,
      records.find((record) => record.sequence === 2)!,
    ) as NormalizationUpdate;
    expect(corrected.fromNativeSequence).toBe(2);
    expect(corrected.traces.map((trace) => trace.nativeSequence)).toEqual([2, 5]);
    expect(corrected.traces[1]!.stateBefore).toMatchObject({ lifecycle: 'running' });
  });

  it('makes Codex buffering, ambient filtering, and driver-owned requests explicit', () => {
    const view = session('codex', [
      { event: 'thread/started', transport: 'jsonrpc-notification' },
      { event: 'turn/started', transport: 'jsonrpc-notification' },
      { event: 'item/completed', transport: 'jsonrpc-notification' },
      { event: 'account/updated', transport: 'jsonrpc-notification' },
      { event: 'item/commandExecution/requestApproval', transport: 'jsonrpc-request' },
      { event: 'turn/completed', transport: 'jsonrpc-notification' },
    ]);
    const lab = createNormalizationLab();
    lab.join(view);
    const snapshot = lab.synchronize(view, [
      emitted(1, 'thread/started', { thread: { id: 'thread-1', cwd: '/work' } }),
      emitted(2, 'turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } }),
      emitted(3, 'item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] },
      }),
      emitted(4, 'item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'assistant-1', text: 'hi' },
      }),
      emitted(5, 'account/updated', { plan: 'test' }),
      emitted(6, 'item/commandExecution/requestApproval', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'tool-1',
      }),
      emitted(7, 'turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null },
      }),
    ]) as NormalizationSnapshot;

    expect(snapshot.traces.map((trace) => trace.disposition)).toEqual([
      'mapped',
      'buffered',
      'mapped',
      'mapped',
      'no-output',
      'driver-owned',
      'mapped',
    ]);
    expect(snapshot.traces[1]!.events).toEqual([]);
    expect(snapshot.traces[2]!.events[0]!.event).toMatchObject({
      type: 'turn.started',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    expect(snapshot.traces[5]!.explanation).toContain('request id and client decision');
    expect(snapshot.state).toMatchObject({
      lifecycle: 'ready',
      activeTurn: undefined,
      lastAssistantMessage: 'hi',
    });
    expect(snapshot.coverage).toMatchObject({
      total: 7,
      mapped: 4,
      buffered: 1,
      noOutput: 1,
      driverOwned: 1,
    });
  });

  it('replays Kimi wire records while keeping hook/state mirrors native-only', () => {
    const view = session('kimi', [
      { event: 'profile.bind', transport: 'jsonl-record' },
      { event: 'turn.prompt', transport: 'jsonl-record' },
      { event: 'context.append_loop_event', transport: 'jsonl-record' },
      { event: 'turn.ended', transport: 'jsonl-record' },
      { event: 'future.record', transport: 'jsonl-record' },
      { event: 'Stop', transport: 'command-stdin' },
    ]);
    const records = [
      emitted(1, 'profile.bind', { modelAlias: 'kimi-imposter', environmentDisclosure: { cwd: '/work' } }, 'wire'),
      emitted(2, 'turn.prompt', { input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' } }, 'wire'),
      emitted(
        3,
        'context.append_loop_event',
        { event: { type: 'step.begin', uuid: 'step-1', turnId: '0', step: 1 } },
        'wire',
      ),
      emitted(
        4,
        'context.append_loop_event',
        {
          event: {
            type: 'content.part',
            uuid: 'content-1',
            turnId: '0',
            step: 1,
            stepUuid: 'step-1',
            part: { type: 'text', text: 'hi' },
          },
        },
        'wire',
      ),
      emitted(5, 'turn.ended', { turnId: 0, reason: 'completed' }, 'wire'),
      emitted(6, 'future.record', { future: true }, 'wire'),
      emitted(7, 'Stop', { hook_event_name: 'Stop' }, 'hook-command'),
    ];
    const lab = createNormalizationLab();
    const first = lab.synchronize(view, records) as NormalizationSnapshot;
    const replayed = lab.synchronize(view, [...records].reverse()) as NormalizationSnapshot;

    expect(replayed).toEqual(first);
    expect(first.traces.map((trace) => trace.disposition)).toEqual([
      'mapped',
      'buffered',
      'mapped',
      'mapped',
      'mapped',
      'retained-native',
      'no-output',
    ]);
    expect(first.traces[2]!.events[0]).toMatchObject({
      source: 'native-log',
      confidence: 'authoritative',
      promptId: '0',
      turnId: '0',
      event: { type: 'turn.started', prompt: 'hello' },
    });
    expect(first.traces[6]!.explanation).toContain('avoid double counting');
    expect(first.state).toMatchObject({
      lifecycle: 'ready',
      activeTurn: undefined,
      lastAssistantMessage: 'hi',
      counters: { unknownEvents: 1 },
    });
    expect(first.limitations.join(' ')).toContain('main-agent wire journal');

    const gapLab = createNormalizationLab();
    gapLab.ingest(view, records[0]!);
    const blocked = gapLab.ingest(view, records[2]!) as NormalizationUpdate;
    expect(blocked).toMatchObject({ complete: false, gaps: [{ from: 2, to: 2 }] });
    const recovered = gapLab.ingest(view, records[1]!) as NormalizationUpdate;
    expect(recovered).toMatchObject({
      complete: true,
      state: { lifecycle: 'running', activeTurn: { id: '0' } },
    });
  });

  it('replays OpenCode SSE records with stateful out-of-order correlation and native retention', () => {
    const view = session('opencode', [
      { event: 'session.created', transport: 'sse-event' },
      { event: 'message.updated', transport: 'sse-event' },
      { event: 'message.part.updated', transport: 'sse-event' },
      { event: 'permission.asked', transport: 'sse-event' },
      { event: 'permission.replied', transport: 'sse-event' },
      { event: 'session.status', transport: 'sse-event' },
      { event: 'future.event', transport: 'sse-event' },
    ]);
    const createdAt = Date.UTC(2026, 7, 9);
    const records = [
      emitted(1, 'session.created', {
        sessionID: view.sessionId,
        info: {
          id: view.sessionId,
          title: 'OpenCode test',
          directory: '/work',
          model: { id: 'opencode-imposter', providerID: 'imposter' },
          time: { created: createdAt, updated: createdAt },
        },
      }),
      emitted(2, 'message.updated', {
        sessionID: view.sessionId,
        info: {
          id: 'msg-user',
          role: 'user',
          sessionID: view.sessionId,
          model: { providerID: 'imposter', modelID: 'opencode-imposter' },
          time: { created: createdAt + 2_000 },
        },
      }),
      emitted(3, 'message.part.updated', {
        sessionID: view.sessionId,
        part: {
          id: 'part-assistant',
          messageID: 'msg-assistant',
          sessionID: view.sessionId,
          type: 'text',
          text: 'hi',
          time: { start: createdAt + 3_000, end: createdAt + 3_500 },
        },
      }),
      emitted(4, 'message.updated', {
        sessionID: view.sessionId,
        info: {
          id: 'msg-assistant',
          parentID: 'msg-user',
          role: 'assistant',
          sessionID: view.sessionId,
          finish: 'stop',
          time: { created: createdAt + 2_500, completed: createdAt + 4_000 },
        },
      }),
      emitted(5, 'permission.asked', {
        id: 'permission-1',
        sessionID: view.sessionId,
        permission: 'bash',
        patterns: ['*'],
        metadata: {},
        always: [],
        tool: { messageID: 'msg-assistant', callID: 'call-1' },
      }),
      emitted(6, 'permission.replied', {
        sessionID: view.sessionId,
        requestID: 'permission-1',
        reply: 'always',
      }),
      emitted(7, 'session.status', { sessionID: view.sessionId, status: { type: 'idle' } }),
      emitted(8, 'future.event', { sessionID: view.sessionId, future: true }),
    ];
    const lab = createNormalizationLab();
    const first = lab.synchronize(view, records) as NormalizationSnapshot;
    const replayed = lab.synchronize(view, [...records].reverse()) as NormalizationSnapshot;

    expect(replayed).toEqual(first);
    expect(first.supported).toBe(true);
    expect(first.traces.map((trace) => trace.disposition)).toEqual([
      'mapped',
      'mapped',
      'buffered',
      'mapped',
      'mapped',
      'mapped',
      'mapped',
      'retained-native',
    ]);
    expect(first.traces[2]).toMatchObject({ events: [], explanation: expect.stringContaining('owning message') });
    expect(first.traces[3]!.events[0]).toMatchObject({
      promptId: 'msg-user',
      turnId: 'msg-user',
      event: { type: 'assistant.message', messageId: 'msg-assistant', text: 'hi', final: true },
    });
    expect(first.traces[3]!.native).toEqual(records[3]);
    expect(first.traces[3]!.events[0]).toMatchObject({ source: 'native-protocol', confidence: 'authoritative' });
    expect(first.traces[7]!.events[0]!.event).toMatchObject({
      type: 'adapter.native-event',
      adapter: 'opencode',
      nativeType: 'future.event',
    });
    expect(first.state).toMatchObject({
      lifecycle: 'ready',
      activeTurn: undefined,
      lastAssistantMessage: 'hi',
      permissions: [],
      environment: {
        currentCwd: { value: '/work', source: 'native-protocol', confidence: 'authoritative' },
        model: {
          value: { id: 'opencode-imposter', provider: 'imposter' },
          source: 'native-protocol',
          confidence: 'authoritative',
        },
      },
      counters: { unknownEvents: 1 },
    });
    expect(first.limitations.join(' ')).toContain('REST hydration');
  });

  it('replays Hermes tui_gateway records into ready and retains hook copies', () => {
    const view = session('hermes', [
      { event: 'gateway.ready', transport: 'jsonrpc-notification' },
      { event: 'session.info', transport: 'jsonrpc-notification' },
      { event: 'on_session_start' },
      { event: 'message.start', transport: 'jsonrpc-notification' },
      { event: 'message.delta', transport: 'jsonrpc-notification' },
      { event: 'message.complete', transport: 'jsonrpc-notification' },
    ]);
    const records = [
      emitted(1, 'gateway.ready'),
      emitted(2, 'session.info', {
        model: 'puppeteer-hermes-census',
        stored_session_id: '20260812_132919_ae981b',
        cwd: '/work',
        running: false,
      }),
      emitted(3, 'on_session_start', { hook_event_name: 'on_session_start', keys: ['session_id'] }, 'plugin-hook'),
      emitted(4, 'message.start'),
      emitted(5, 'message.delta', { text: 'SURFACE_HERMES_OK' }),
      emitted(6, 'message.complete', { text: 'SURFACE_HERMES_OK', status: 'complete' }),
    ];
    const lab = createNormalizationLab();
    const first = lab.synchronize(view, records) as NormalizationSnapshot;
    const replayed = lab.synchronize(view, [...records].reverse()) as NormalizationSnapshot;

    expect(replayed).toEqual(first);
    expect(first.supported).toBe(true);
    expect(first.traces.map((trace) => trace.disposition)).toEqual([
      'retained-native',
      'mapped',
      'retained-native',
      'mapped',
      'mapped',
      'mapped',
    ]);
    expect(first.state).toMatchObject({
      lifecycle: 'ready',
      lastAssistantMessage: 'SURFACE_HERMES_OK',
      environment: {
        currentCwd: { value: '/work', source: 'native-protocol', confidence: 'authoritative' },
        model: {
          value: { id: 'puppeteer-hermes-census' },
          source: 'native-protocol',
          confidence: 'authoritative',
        },
      },
    });
    expect(first.limitations.join(' ')).toContain('native-TUI approvals');
  });

  it('labels a vendor without a pure emitted-record normalizer instead of inventing semantics', () => {
    const view = session('grok', [{ event: 'assistant.delta' }]);
    const lab = createNormalizationLab();
    const snapshot = lab.synchronize(view, [emitted(1, 'assistant.delta', { text: 'hi' })]) as NormalizationSnapshot;

    expect(snapshot.supported).toBe(false);
    expect(snapshot.traces[0]).toMatchObject({ disposition: 'unsupported', events: [] });
    expect(snapshot.limitations.join(' ')).toContain('pure emitted-record normalizer');
    expect(snapshot.state).toMatchObject({ lifecycle: 'preparing', lastSequence: 0 });
  });

  it('keeps complete logical state while bounding only the shared presentation window', () => {
    const view = session('claude', [
      { event: 'SessionStart', transport: 'hook' },
      { event: 'FutureHook', transport: 'hook' },
    ]);
    const lab = createNormalizationLab();
    lab.join(view);
    lab.ingest(view, emitted(1, 'SessionStart', { session_id: view.sessionId }));

    const before = lab.snapshot(view) as NormalizationSnapshot;
    const firstTrace = before.traces[0];
    lab.ingest(view, emitted(2, 'FutureHook'));
    expect((lab.snapshot(view) as NormalizationSnapshot).traces[0]).toBe(firstTrace);

    let update: NormalizationUpdate | undefined;
    for (let sequence = 3; sequence <= NORMALIZATION_WINDOW_RECORDS + 5; sequence += 1) {
      update = lab.ingest(view, emitted(sequence, 'FutureHook')) as NormalizationUpdate;
    }
    const snapshot = lab.snapshot(view) as NormalizationSnapshot;

    expect(snapshot).toMatchObject({
      complete: true,
      processedThroughSequence: NORMALIZATION_WINDOW_RECORDS + 5,
      observedThroughSequence: NORMALIZATION_WINDOW_RECORDS + 5,
      windowStartSequence: 6,
      windowEndSequence: NORMALIZATION_WINDOW_RECORDS + 5,
      gaps: [],
      state: {
        lifecycle: 'ready',
        counters: { unknownEvents: NORMALIZATION_WINDOW_RECORDS + 4 },
      },
    });
    expect(snapshot.traces).toHaveLength(NORMALIZATION_WINDOW_RECORDS);
    expect(snapshot.traces.some((trace) => trace.nativeSequence === 1)).toBe(false);
    expect(snapshot.coverage.total).toBe(NORMALIZATION_WINDOW_RECORDS);
    expect(update).toMatchObject({
      windowStartSequence: 6,
      fromNativeSequence: NORMALIZATION_WINDOW_RECORDS + 5,
    });
  });

  it('holds later records behind a sequence gap and deterministically drains them after backfill', () => {
    const view = session('claude', [
      { event: 'SessionStart', transport: 'hook' },
      { event: 'FutureHook', transport: 'hook' },
    ]);
    const lab = createNormalizationLab();
    lab.ingest(view, emitted(1, 'SessionStart', { session_id: view.sessionId }));

    const blocked = lab.ingest(view, emitted(3, 'FutureHook', { order: 3 })) as NormalizationUpdate;
    expect(blocked).toMatchObject({
      complete: false,
      processedThroughSequence: 1,
      observedThroughSequence: 3,
      gaps: [{ from: 2, to: 2 }],
      traces: [{ nativeSequence: 3, disposition: 'blocked', events: [] }],
      state: { lifecycle: 'ready', counters: { unknownEvents: 0 } },
    });

    const recovered = lab.ingest(view, emitted(2, 'FutureHook', { order: 2 })) as NormalizationUpdate;
    expect(recovered).toMatchObject({
      complete: true,
      processedThroughSequence: 3,
      observedThroughSequence: 3,
      gaps: [],
      fromNativeSequence: 2,
      state: { lifecycle: 'ready', counters: { unknownEvents: 2 } },
    });
    expect(recovered.traces.map((trace) => [trace.nativeSequence, trace.disposition])).toEqual([
      [2, 'retained-native'],
      [3, 'retained-native'],
    ]);
  });

  it('retains the nearest pending evidence when a gap backlog exceeds its memory bound', () => {
    const view = session('claude', [
      { event: 'SessionStart', transport: 'hook' },
      { event: 'FutureHook', transport: 'hook' },
    ]);
    const lab = createNormalizationLab();
    lab.ingest(view, emitted(1, 'SessionStart', { session_id: view.sessionId }));
    lab.synchronize(
      view,
      Array.from({ length: 501 }, (_, index) => emitted(index + 3, 'FutureHook')),
    );

    const afterGap = lab.ingest(view, emitted(2, 'FutureHook')) as NormalizationUpdate;
    expect(afterGap).toMatchObject({
      complete: false,
      processedThroughSequence: 502,
      observedThroughSequence: 503,
      gaps: [{ from: 503, to: 503 }],
      state: { counters: { unknownEvents: 501 } },
    });
    expect(afterGap.limitations.join(' ')).toContain('in-memory bound');

    const complete = lab.ingest(view, emitted(503, 'FutureHook')) as NormalizationUpdate;
    expect(complete).toMatchObject({
      complete: true,
      processedThroughSequence: 503,
      observedThroughSequence: 503,
      gaps: [],
      state: { counters: { unknownEvents: 502 } },
    });
    expect(complete.limitations.join(' ')).not.toContain('in-memory bound');
  });
});
