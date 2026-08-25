import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createEnvelopeStamper,
  createInitialSessionState,
  reduceSessionState,
  type AgentEventEnvelope,
} from '@vibecook/chopsticks-core';
import { describe, expect, it } from 'vitest';
import type { OpenCodeSseRecord } from './event-stream.js';
import { OpenCodeNormalizer, type OpenCodeNormalizedEvent } from './normalizer.js';

function fixture(name: string): OpenCodeSseRecord[] {
  const path = fileURLToPath(
    new URL(`../../surface/vendors/opencode/captures/opencode@1.18.16/${name}/events.jsonl`, import.meta.url),
  );
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as OpenCodeSseRecord);
}

function sessionID(records: OpenCodeSseRecord[]): string {
  const created = records.find((record) => record.type === 'session.created');
  const info = created?.properties.info as { id?: unknown } | undefined;
  if (typeof info?.id !== 'string') throw new Error('fixture has no session.created id');
  return info.id;
}

function normalizeFixture(name: string, capacity?: number): OpenCodeNormalizedEvent[] {
  const records = fixture(name);
  const normalizer = new OpenCodeNormalizer({
    sessionID: sessionID(records),
    ...(capacity === undefined ? {} : { contextWindowCapacityTokens: capacity }),
  });
  return records.flatMap((record) => normalizer.normalize(record));
}

function reduce(events: OpenCodeNormalizedEvent[]) {
  const stamper = createEnvelopeStamper();
  let state = createInitialSessionState();
  for (const normalized of events) {
    state = reduceSessionState(
      state,
      stamper.next({
        sessionId: 'session',
        nativeSessionId: 'session',
        ...(normalized.promptId ? { promptId: normalized.promptId } : {}),
        ...(normalized.turnId ? { turnId: normalized.turnId } : {}),
        timestamp: normalized.timestamp,
        monotonicTime: 0,
        source: normalized.source,
        confidence: normalized.confidence,
        event: normalized.event,
        nativeEvent: normalized.nativeEvent,
      }) as AgentEventEnvelope,
    );
  }
  return state;
}

describe('OpenCode normalizer over Surface-owned captures', () => {
  it('maps a captured turn with exact prompt correlation, streaming text, reasoning, context, and idle completion', () => {
    const events = normalizeFixture('turn', 100);
    const types = events.map((entry) => entry.event.type);
    expect(types).toContain('session.started');
    expect(types).toContain('session.environment.updated');
    expect(types).toContain('turn.started');
    expect(types).toContain('reasoning.started');
    expect(types).toContain('reasoning.summary');
    expect(types).toContain('reasoning.completed');
    expect(types).toContain('assistant.message');
    expect(types).toContain('context-window.updated');
    expect(types.filter((type) => type === 'turn.completed')).toHaveLength(1);

    const turn = events.find((entry) => entry.event.type === 'turn.started')!;
    expect(turn.promptId).toMatch(/^msg_/);
    expect(turn.turnId).toBe(turn.promptId);
    const context = events.find((entry) => entry.event.type === 'context-window.updated')!.event;
    expect(context).toMatchObject({ usedTokens: 18, capacityTokens: 100 });
    expect(events.every((entry) => entry.source === 'native-protocol')).toBe(true);
    expect(events.every((entry) => entry.nativeEvent !== undefined)).toBe(true);

    const state = reduce(events);
    expect(state.lifecycle).toBe('ready');
    expect(state.activeTurn).toBeUndefined();
    expect(state.activeReasoning).toBeUndefined();
    expect(state.lastAssistantMessage).toBe('<redacted:text>');
  });

  it('maps captured permission denial and tool terminal states without leaking reducer resources', () => {
    const events = normalizeFixture('permission-reject');
    expect(events.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'permission.requested' }),
        expect.objectContaining({ type: 'permission.resolved', outcome: 'denied' }),
        expect.objectContaining({ type: 'tool.requested' }),
        expect.objectContaining({ type: 'tool.started' }),
        expect.objectContaining({ type: 'tool.failed' }),
      ]),
    );
    const state = reduce(events);
    expect(state.permissions.size).toBe(0);
    expect(state.tools.size).toBe(0);
    expect(state.counters.toolsFailed).toBeGreaterThan(0);
  });

  it('detects captured native option questions and their correlated answer', () => {
    const events = normalizeFixture('question-reply');
    const requested = events.find((entry) => entry.event.type === 'question.requested');
    expect(requested?.event).toMatchObject({
      type: 'question.requested',
      requestId: 'que_a11a5ed05a1f59c0bc08d90a8d',
      questions: [
        {
          header: '<redacted:header>',
          prompt: '<redacted:question>',
          allowMultiple: false,
          allowFreeForm: true,
          options: [
            { label: '<redacted:label>', description: '<redacted:description>' },
            { label: '<redacted:label>', description: '<redacted:description>' },
          ],
        },
      ],
    });
    expect(events.map((entry) => entry.event)).toContainEqual({
      type: 'question.resolved',
      requestId: 'que_a11a5ed05a1f59c0bc08d90a8d',
      outcome: 'answered',
    });
    expect(events.filter((entry) => entry.event.type === 'question.requested')).toHaveLength(1);
  });

  it('keeps native question rejection distinct from permission denial', () => {
    const events = normalizeFixture('question-reject');
    expect(events.map((entry) => entry.event)).toContainEqual({
      type: 'question.resolved',
      requestId: 'que_a11a5ed0e6c279ae26af86edf9',
      outcome: 'cancelled',
    });
    expect(events.filter((entry) => entry.event.type === 'permission.requested')).toEqual([]);
  });

  it('keeps a captured provider failure terminal despite later idle traffic', () => {
    const events = normalizeFixture('provider-error');
    expect(events.filter((entry) => entry.event.type === 'turn.failed')).toHaveLength(1);
    expect(events.filter((entry) => entry.event.type === 'turn.completed')).toHaveLength(0);
    expect(reduce(events).activeTurn).toBeUndefined();
  });

  it('recovers a captured overflow error through automatic compaction instead of failing the turn', () => {
    const events = normalizeFixture('overflow-compaction');
    expect(events.filter((entry) => entry.event.type === 'turn.started')).toHaveLength(1);
    expect(events.filter((entry) => entry.event.type === 'turn.failed')).toHaveLength(0);
    expect(events.filter((entry) => entry.event.type === 'turn.completed')).toHaveLength(1);
    expect(events.map((entry) => entry.event)).toContainEqual({
      type: 'context-window.invalidated',
      reason: 'compacted',
    });
    expect(reduce(events).activeTurn).toBeUndefined();
  });

  it('keeps a captured abort failure terminal after idle', () => {
    const events = normalizeFixture('abort-stream');
    expect(events.filter((entry) => entry.event.type === 'turn.failed')).toHaveLength(1);
    expect(events.filter((entry) => entry.event.type === 'turn.completed')).toHaveLength(0);
  });

  it('keeps automatic threshold compaction on the same captured turn', () => {
    const events = normalizeFixture('auto-compaction');
    expect(events.filter((entry) => entry.event.type === 'turn.started')).toHaveLength(1);
    expect(events.filter((entry) => entry.event.type === 'turn.failed')).toHaveLength(0);
    expect(events.filter((entry) => entry.event.type === 'turn.completed')).toHaveLength(1);
    expect(events.map((entry) => entry.event)).toContainEqual({
      type: 'context-window.invalidated',
      reason: 'compacted',
    });
  });

  it('invalidates context on captured compaction', () => {
    const events = normalizeFixture('manual-compaction', 100);
    expect(events.map((entry) => entry.event)).toContainEqual({
      type: 'context-window.invalidated',
      reason: 'compacted',
    });
  });

  it('buffers out-of-order assistant parts, suppresses duplicates, and retains unknown native events', () => {
    const normalizer = new OpenCodeNormalizer({ sessionID: 'ses_1' });
    const user: OpenCodeSseRecord = {
      id: 'evt_user',
      type: 'message.updated',
      properties: { sessionID: 'ses_1', info: { id: 'msg_user', role: 'user', sessionID: 'ses_1' } },
    };
    const earlyPart: OpenCodeSseRecord = {
      id: 'evt_part',
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        part: {
          id: 'prt_text',
          messageID: 'msg_assistant',
          sessionID: 'ses_1',
          type: 'text',
          text: 'answer',
          time: { start: 1, end: 2 },
        },
      },
    };
    const assistant: OpenCodeSseRecord = {
      id: 'evt_assistant',
      type: 'message.updated',
      properties: {
        sessionID: 'ses_1',
        info: {
          id: 'msg_assistant',
          parentID: 'msg_user',
          role: 'assistant',
          sessionID: 'ses_1',
          time: { created: 1, completed: 2 },
          finish: 'stop',
        },
      },
    };
    const unknown: OpenCodeSseRecord = {
      id: 'evt_unknown',
      type: 'future.session.fact',
      properties: { sessionID: 'ses_1', value: 1 },
    };

    expect(normalizer.normalize(user).map((entry) => entry.event.type)).toEqual(['turn.started']);
    expect(normalizer.normalize(earlyPart)).toEqual([]);
    expect(normalizer.normalize(assistant).map((entry) => entry.event)).toContainEqual(
      expect.objectContaining({ type: 'assistant.message', text: 'answer', final: true }),
    );
    expect(normalizer.normalize(assistant)).toEqual([]);
    const retained = normalizer.normalize(unknown);
    expect(retained).toHaveLength(1);
    expect(retained[0]!.event).toEqual({
      type: 'adapter.native-event',
      adapter: 'opencode',
      nativeType: 'future.session.fact',
    });
    expect(retained[0]!.nativeEvent).toBe(unknown);
  });

  it('maps a captured foreground child session to one subagent lifecycle without a second parent session', () => {
    const events = normalizeFixture('task-child');
    const types = events.map((entry) => entry.event.type);
    expect(types.filter((type) => type === 'session.started')).toHaveLength(1);
    expect(types.filter((type) => type === 'subagent.started')).toHaveLength(1);
    expect(types.filter((type) => type === 'subagent.stopped')).toHaveLength(1);
    expect(types.filter((type) => type === 'turn.completed')).toHaveLength(1);

    const started = events.find((entry) => entry.event.type === 'subagent.started')!.event;
    const stopped = events.find((entry) => entry.event.type === 'subagent.stopped')!.event;
    expect(started).toMatchObject({
      type: 'subagent.started',
      subagentId: 'ses_a11a5ed0a84e8d6d6a9ea922a5',
      agentType: '<redacted:agent>',
    });
    expect(stopped).toEqual({ type: 'subagent.stopped', subagentId: 'ses_a11a5ed0a84e8d6d6a9ea922a5' });
    expect(types.indexOf('subagent.started')).toBeLessThan(types.indexOf('subagent.stopped'));
    expect(types.indexOf('subagent.stopped')).toBeLessThan(types.lastIndexOf('turn.completed'));

    const state = reduce(events);
    expect(state.subagents.size).toBe(0);
    expect(state.activeTurn).toBeUndefined();
    expect(state.tools.size).toBe(0);
  });

  it('keeps a captured background child active after the parent first goes idle', () => {
    const events = normalizeFixture('background-task');
    const startedAt = events.findIndex((entry) => entry.event.type === 'subagent.started');
    const firstParentIdle = events.findIndex((entry) => entry.event.type === 'turn.completed');
    const stoppedAt = events.findIndex((entry) => entry.event.type === 'subagent.stopped');
    const lastParentIdle = events.reduce(
      (last, entry, index) => (entry.event.type === 'turn.completed' ? index : last),
      -1,
    );

    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(firstParentIdle).toBeGreaterThan(startedAt);
    expect(stoppedAt).toBeGreaterThan(firstParentIdle);
    expect(lastParentIdle).toBeGreaterThan(stoppedAt);
    expect(events.filter((entry) => entry.event.type === 'subagent.started')).toHaveLength(1);
    expect(events.filter((entry) => entry.event.type === 'subagent.stopped')).toHaveLength(1);
    expect(events.filter((entry) => entry.event.type === 'turn.completed')).toHaveLength(2);

    const mid = reduce(events.slice(0, firstParentIdle + 1));
    expect(mid.subagents.size).toBe(1);
    expect(mid.subagents.has('ses_a11a5ed0f25364ecd57ac53f24')).toBe(true);
    expect(reduce(events).subagents.size).toBe(0);
  });

  it('does not treat a captured fork as a subagent', () => {
    const events = normalizeFixture('session-lifecycle');
    expect(events.filter((entry) => entry.event.type.startsWith('subagent.'))).toEqual([]);
    expect(events.filter((entry) => entry.event.type === 'session.started')).toHaveLength(1);
  });

  it('joins a child from task metadata when session.created is missing or late', () => {
    const normalizer = new OpenCodeNormalizer({ sessionID: 'ses_parent' });
    expect(
      normalizer
        .normalize({
          id: 'evt_user',
          type: 'message.updated',
          properties: { sessionID: 'ses_parent', info: { id: 'msg_user', role: 'user', sessionID: 'ses_parent' } },
        })
        .map((entry) => entry.event.type),
    ).toEqual(['turn.started']);
    expect(
      normalizer.normalize({
        id: 'evt_assistant',
        type: 'message.updated',
        properties: {
          sessionID: 'ses_parent',
          info: { id: 'msg_assistant', parentID: 'msg_user', role: 'assistant', sessionID: 'ses_parent' },
        },
      }),
    ).toEqual([]);

    const fromMetadata = normalizer.normalize({
      id: 'evt_task',
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_parent',
        part: {
          id: 'prt_task',
          messageID: 'msg_assistant',
          sessionID: 'ses_parent',
          type: 'tool',
          tool: 'task',
          callID: 'call_1',
          state: {
            status: 'running',
            input: { subagent_type: 'explore' },
            metadata: { parentSessionId: 'ses_parent', sessionId: 'ses_child' },
          },
        },
      },
    });
    expect(fromMetadata.map((entry) => entry.event)).toEqual([
      { type: 'subagent.started', subagentId: 'ses_child', agentType: 'explore' },
      expect.objectContaining({ type: 'tool.started', toolCallId: 'call_1', tool: 'task' }),
    ]);

    const lateCreated = normalizer.normalize({
      id: 'evt_child',
      type: 'session.created',
      properties: {
        sessionID: 'ses_child',
        info: { id: 'ses_child', parentID: 'ses_parent', agent: 'explore' },
      },
    });
    expect(lateCreated).toEqual([]);
    expect(
      normalizer
        .normalize({
          id: 'evt_child_idle',
          type: 'session.idle',
          properties: { sessionID: 'ses_child' },
        })
        .map((entry) => entry.event),
    ).toEqual([{ type: 'subagent.stopped', subagentId: 'ses_child' }]);
  });
});
