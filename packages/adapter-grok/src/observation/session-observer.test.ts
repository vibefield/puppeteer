import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGrokSessionObserver } from './session-observer.js';
import { grokExtensionEvents } from '../normalization/adapter.js';
import { GrokConversationNormalizer } from '../normalization/conversation.js';
import { GrokUpdateNormalizer } from '../normalization/pipeline.js';
import type { GrokObservedEvent, GrokObservedFactory, GrokSessionObserver } from '../normalization/types.js';
import { grokUpdatesPath, latestGrokSessionId } from './session-discovery.js';

const temporaryDirectories: string[] = [];

it('uses the native model cache for live context before the first signals snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-initial-context-'));
  temporaryDirectories.push(directory);
  const updatesPath = grokUpdatesPath('/repo', 'session', directory);
  await mkdir(dirname(updatesPath), { recursive: true });
  await writeFile(
    join(directory, 'models_cache.json'),
    JSON.stringify({ models: { 'grok-4.6': { context_window: 500_000 } } }),
  );
  await writeFile(join(dirname(updatesPath), 'summary.json'), JSON.stringify({ current_model_id: 'grok-4.6' }));
  await writeFile(
    updatesPath,
    JSON.stringify({
      timestamp: 1_789_167_927,
      method: 'session/update',
      params: {
        sessionId: 'session',
        update: { sessionUpdate: 'agent_thought_chunk' },
        _meta: { promptId: 'p', totalTokens: 1_897 },
      },
    }) + '\n',
  );
  const observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000 });
  const received: GrokObservedEvent[] = [];
  observer.onEvent((event) => received.push(event));
  try {
    await observer.poll();
    expect(received).toContainEqual(
      expect.objectContaining({
        event: { type: 'context-window:updated', usedTokens: 1_897, capacityTokens: 500_000 },
        timestamp: '2026-09-11T23:05:27.000Z',
      }),
    );
  } finally {
    observer.stop();
  }
});

it('refreshes context from live log metadata while signals still describe the previous turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-live-context-'));
  temporaryDirectories.push(directory);
  const updatesPath = join(directory, 'updates.jsonl');
  const signalsPath = join(directory, 'signals.json');
  await writeFile(updatesPath, '');
  await writeFile(signalsPath, JSON.stringify({ contextTokensUsed: 10, contextWindowTokens: 500_000 }));
  const at = 1_784_669_125_000;
  await utimes(signalsPath, new Date(at - 1_000), new Date(at - 1_000));
  const observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000 });
  const received: GrokObservedEvent[] = [];
  observer.onEvent((event) => received.push(event));
  try {
    await observer.poll();
    for (const totalTokens of [120_000, 121_000]) {
      await appendFile(
        updatesPath,
        JSON.stringify({
          method: 'session/update',
          timestamp: at / 1_000,
          params: {
            sessionId: 'grok-session',
            update: { sessionUpdate: 'agent_thought_chunk' },
            _meta: { promptId: 'prompt-1', agentTimestampMs: at, totalTokens },
          },
        }) + '\n',
      );
      await observer.poll();
    }
    const context = received.filter(({ event }) => event.type === 'context-window:updated');
    expect(context.map(({ event }) => event)).toEqual([
      { type: 'context-window:updated', usedTokens: 10, capacityTokens: 500_000, modelId: undefined },
      { type: 'context-window:updated', usedTokens: 120_000, capacityTokens: 500_000 },
      { type: 'context-window:updated', usedTokens: 121_000, capacityTokens: 500_000 },
    ]);
    expect(context.at(-1)).toMatchObject({ phase: 'live', timestamp: new Date(at).toISOString() });
    await observer.poll();
    expect(received.filter(({ event }) => event.type === 'context-window:updated')).toHaveLength(3);
  } finally {
    observer.stop();
  }
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(update: Record<string, unknown>, promptId?: string, meta: Record<string, unknown> = {}): unknown {
  return {
    timestamp: 1_784_669_125_000,
    method:
      update.sessionUpdate === 'turn_completed' || update.sessionUpdate === 'hook_execution'
        ? '_x.ai/session/update'
        : 'session/update',
    params: {
      sessionId: 'grok-session',
      update,
      _meta: promptId ? { promptId, agentTimestampMs: 1_784_669_125_000, ...meta } : undefined,
    },
  };
}

function jsonl(...records: unknown[]): string {
  return records.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

function thoughtChunk(promptId: string): unknown {
  return record({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private' } }, promptId);
}

/** The log echoes a person's text with no prompt id, at its own time (Unix seconds). */
function userChunk(text: string, timestamp: number): unknown {
  return { ...(record({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }) as object), timestamp };
}

/** One turn as the Imposter's leader writes it, a few milliseconds apart: the user's echo, the answer, then the end. */
function imposterTurn(promptId: string, prompt: string): { user: unknown; answer: unknown; end: unknown } {
  return {
    user: userChunk(prompt, 1_784_669_125),
    answer: record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'imposter: ok' } }, promptId),
    end: record({ sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn' }),
  };
}

function twoTurnRecords(): unknown[] {
  return [
    record({ sessionUpdate: 'hook_execution', event_name: 'session_start' }),
    record({ sessionUpdate: 'hook_execution', event_name: 'user_prompt_submit', prompt_id: 'prompt-1' }),
    record({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first question' } }),
    record({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private thought' } }, 'prompt-1'),
    record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first ' } }, 'prompt-1'),
    record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }, 'prompt-1'),
    record({ sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: 'end_turn' }),
    record({ sessionUpdate: 'hook_execution', event_name: 'user_prompt_submit', prompt_id: 'prompt-2' }),
    record({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second question' } }),
    record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second answer' } }, 'prompt-2'),
    record({ sessionUpdate: 'turn_completed', prompt_id: 'prompt-2', stop_reason: 'end_turn' }),
  ];
}

describe('GrokUpdateNormalizer', () => {
  it('accepts only the two ground-truth durable update carriers', () => {
    const normalizer = new GrokUpdateNormalizer();
    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'must not be consumed' },
    };

    expect(
      normalizer.normalize({
        ...(record(update, 'prompt-1') as Record<string, unknown>),
        method: '_x.ai/session_notification',
      }),
    ).toEqual([]);
  });

  it('preserves the nested identity of live xAI extension notifications', () => {
    expect(
      grokExtensionEvents('_x.ai/session_notification', {
        sessionId: 'grok-session',
        update: { sessionUpdate: 'auto_compact_started' },
      }),
    ).toEqual([{ type: 'adapter:native-event', adapter: 'grok', nativeType: 'auto_compact_started' }]);
  });

  it('frames two terminal-authored turns with stable, distinct message identities', () => {
    const normalizer = new GrokUpdateNormalizer();
    const events = twoTurnRecords().flatMap((entry) => normalizer.normalize(entry));

    expect(events.filter(({ event }) => event.type === 'turn:started').map(({ event }) => event)).toEqual([
      { type: 'turn:started', turnId: 'prompt-1', prompt: 'first question' },
      { type: 'turn:started', turnId: 'prompt-2', prompt: 'second question' },
    ]);
    const assistant = events
      .filter(({ event }) => event.type === 'conversation:assistant-message' && event.final)
      .map(({ event, promptId }) => ({ event, promptId }));
    expect(assistant).toEqual([
      {
        promptId: 'prompt-1',
        event: expect.objectContaining({
          messageId: 'grok-assistant:prompt-1',
          text: 'first answer',
          final: true,
        }),
      },
      {
        promptId: 'prompt-2',
        event: expect.objectContaining({
          messageId: 'grok-assistant:prompt-2',
          text: 'second answer',
          final: true,
        }),
      },
    ]);
    expect(events.filter(({ event }) => event.type === 'turn:completed').map(({ promptId }) => promptId)).toEqual([
      'prompt-1',
      'prompt-2',
    ]);
    expect(events.some(({ event }) => event.type === 'reasoning:summary')).toBe(false);
  });

  it('closes reasoning at the first message or tool record after a thought, and reopens it at a later one', () => {
    const normalizer = new GrokUpdateNormalizer();
    const thought = record({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private' } }, 'p1');
    const records = [
      thought,
      record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me look.' } }, 'p1'),
      thought,
      record({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', status: 'in_progress' }, 'p1'),
      record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }, 'p1'),
      record({ sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: 'end_turn' }),
    ];
    const events = records.flatMap((entry) => normalizer.normalize(entry)).map(({ event }) => event);

    // Core ranks reasoning above responding: a thought left open labels the answer and the tool as reasoning.
    expect(events.map(({ type }) => type)).toEqual([
      'reasoning:started',
      'reasoning:completed',
      'conversation:assistant-message',
      'reasoning:started',
      'reasoning:completed',
      'tool:started',
      'conversation:assistant-message',
      'conversation:assistant-message',
      'turn:completed',
    ]);
    expect(events.filter(({ type }) => type.startsWith('reasoning:'))).toEqual([
      { type: 'reasoning:started', reasoningId: 'p1' },
      { type: 'reasoning:completed', reasoningId: 'p1' },
      { type: 'reasoning:started', reasoningId: 'p1' },
      { type: 'reasoning:completed', reasoningId: 'p1' },
    ]);
  });

  it('frames each stream segment of a turn as its own message and ends the turn with the last one', () => {
    // Synthetic records: the committed captures sanitise every `_meta.streamStartMs` to one value.
    const normalizer = new GrokUpdateNormalizer();
    const s1 = { streamStartMs: 1 };
    const s2 = { streamStartMs: 2 };
    const records = [
      record({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } }, 'p1', s1),
      record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me look.' } }, 'p1', s1),
      record({ sessionUpdate: 'tool_call', toolCallId: 'T', kind: 'read', status: 'in_progress' }, 'p1', s1),
      record({ sessionUpdate: 'tool_call_update', toolCallId: 'T', status: 'completed' }, 'p1', s1),
      record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done: 3 files.' } }, 'p1', s2),
      record({ sessionUpdate: 'turn_completed', prompt_id: 'p1', stop_reason: 'end_turn' }),
    ];
    const events = records.flatMap((entry) => normalizer.normalize(entry)).map(({ event }) => event);
    const messages = events.flatMap((event) => (event.type === 'conversation:assistant-message' ? [event] : []));

    expect(messages.map(({ messageId, text, final }) => [messageId, text, final])).toEqual([
      ['grok-assistant:p1', 'Let me look.', false],
      ['grok-assistant:p1:1', 'Done: 3 files.', false],
      ['grok-assistant:p1:1', 'Done: 3 files.', true],
    ]);
    expect(events.find(({ type }) => type === 'turn:completed')).toMatchObject({
      lastAssistantMessage: 'Done: 3 files.',
    });
  });

  it('opens a segment at a new stream, and appends within one stream or when the record names none', () => {
    const normalizer = new GrokUpdateNormalizer();
    const message = (text: string, promptId: string, streamStartMs?: number) =>
      record(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        promptId,
        streamStartMs === undefined ? {} : { streamStartMs },
      );
    const records = [
      message('one', 'p1', 1),
      message(' more', 'p1', 1),
      message('two', 'p1', 2),
      message('three', 'p2'),
      message(' more', 'p2', 5),
      message(' still', 'p2'),
    ];
    const events = records.flatMap((entry) => normalizer.normalize(entry)).map(({ event }) => event);
    const messages = events.flatMap((event) => (event.type === 'conversation:assistant-message' ? [event] : []));

    expect(messages.map(({ messageId, text }) => [messageId, text])).toEqual([
      ['grok-assistant:p1', 'one'],
      ['grok-assistant:p1', 'one more'],
      ['grok-assistant:p1:1', 'two'],
      ['grok-assistant:p2', 'three'],
      ['grok-assistant:p2', 'three more'],
      ['grok-assistant:p2', 'three more still'],
    ]);
  });

  it('fails a turn whose turn_completed names an error_kind, whatever its stop_reason', () => {
    const normalizer = new GrokUpdateNormalizer();
    const turn = (promptId: string, end: Record<string, unknown>) => [
      record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } }, promptId),
      record({ sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn', ...end }),
    ];
    const records = [
      ...turn('p1', { error_kind: 'rate_limit' }),
      ...turn('p2', {}),
      ...turn('p3', { error_kind: null }),
      ...turn('p4', { error_kind: '' }),
    ];
    const events = records.flatMap((entry) => normalizer.normalize(entry)).map(({ event }) => event);

    expect(events.filter(({ type }) => type === 'turn:completed' || type === 'turn:failed')).toEqual([
      { type: 'turn:failed', turnId: 'p1', error: 'rate_limit' },
      expect.objectContaining({ type: 'turn:completed', turnId: 'p2', stopReason: 'end_turn' }),
      expect.objectContaining({ type: 'turn:completed', turnId: 'p3', stopReason: 'end_turn' }),
      expect.objectContaining({ type: 'turn:completed', turnId: 'p4', stopReason: 'end_turn' }),
    ]);
    // The answer a refused turn streamed is still its final message.
    expect(events.filter((event) => event.type === 'conversation:assistant-message' && event.final)).toHaveLength(4);
  });

  it('correlates a user echo even when no user-prompt hook supplies the UUID', () => {
    const normalizer = new GrokUpdateNormalizer();
    expect(
      normalizer.normalize(
        record({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hookless question' },
          _meta: { promptIndex: 0 },
        }),
      ),
    ).toEqual([]);

    const events = normalizer.normalize(
      record(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hookless answer' } },
        'real-prompt',
      ),
    );
    expect(events.map(({ event }) => event)).toEqual([
      { type: 'turn:started', turnId: 'real-prompt', prompt: 'hookless question' },
      expect.objectContaining({
        type: 'conversation:assistant-message',
        messageId: 'grok-assistant:real-prompt',
        turnId: 'real-prompt',
        text: 'hookless answer',
      }),
    ]);
    expect(events.map(({ promptId }) => promptId)).toEqual(['real-prompt', 'real-prompt']);
  });

  it('normalizes the native subagent endpoints while retaining progress as an unknown native event', () => {
    const normalizer = new GrokUpdateNormalizer();
    const started = normalizer.normalize(
      record({ sessionUpdate: 'subagent_spawned', subagent_id: 'child-1', subagent_type: 'explore' }, 'prompt-1'),
    );
    const progress = normalizer.normalize(
      record({ sessionUpdate: 'subagent_progress', subagent_id: 'child-1', turn_count: 2 }, 'prompt-1'),
    );
    const stopped = normalizer.normalize(
      record({ sessionUpdate: 'subagent_finished', subagent_id: 'child-1', status: 'completed' }, 'prompt-1'),
    );

    expect(started.map(({ event }) => event)).toEqual([
      { type: 'delegation:subagent-started', subagentId: 'child-1', agentType: 'explore' },
    ]);
    expect(progress.map(({ event }) => event)).toEqual([
      { type: 'adapter:native-event', adapter: 'grok', nativeType: 'subagent_progress' },
    ]);
    expect(stopped.map(({ event }) => event)).toEqual([{ type: 'delegation:subagent-stopped', subagentId: 'child-1' }]);
  });

  it('retains every native compact phase without inventing a normalized Core state', () => {
    const normalizer = new GrokUpdateNormalizer();
    const phases = [
      'auto_compact_started',
      'compaction_checkpoint',
      'auto_compact_completed',
      'auto_compact_failed',
      'auto_compact_cancelled',
    ];

    expect(phases.flatMap((sessionUpdate) => normalizer.normalize(record({ sessionUpdate }, 'prompt-1')))).toEqual(
      phases.map((nativeType) =>
        expect.objectContaining({
          promptId: 'prompt-1',
          source: 'native-log',
          event: { type: 'adapter:native-event', adapter: 'grok', nativeType },
        }),
      ),
    );
  });
});

describe('GrokConversationNormalizer', () => {
  it('keeps no text of a turn it completed', () => {
    const conversation = new GrokConversationNormalizer();
    const observed: GrokObservedFactory = (event, promptId) => ({ event, promptId, nativeEvent: undefined });
    const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } };
    conversation.append(update, 'p1', observed);

    expect(conversation.complete('p1', observed).text).toBe('answer');
    expect(conversation.complete('p1', observed)).toEqual({ events: [] });
  });
});

describe('createGrokSessionObserver', () => {
  it('resolves bare --resume to the most recently updated cwd-scoped session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'puppeteer-grok-home-'));
    temporaryDirectories.push(home);
    const older = grokUpdatesPath('/work/repo', 'older-session', home);
    const newer = grokUpdatesPath('/work/repo', 'newer-session', home);
    await mkdir(dirname(older), { recursive: true });
    await mkdir(dirname(newer), { recursive: true });
    await writeFile(older, '{}\n');
    await writeFile(newer, '{}\n');
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));

    await expect(latestGrokSessionId('/work/repo', home)).resolves.toBe('newer-session');
    await expect(latestGrokSessionId('/other/repo', home)).resolves.toBeUndefined();
  });

  it('never resumes a subagent child session that shares the cwd bucket', async () => {
    const home = await mkdtemp(join(tmpdir(), 'puppeteer-grok-home-'));
    temporaryDirectories.push(home);
    const parent = grokUpdatesPath('/work/repo', 'parent-session', home);
    const child = grokUpdatesPath('/work/repo', 'child-session', home);
    const unreadable = grokUpdatesPath('/work/repo', 'unreadable-summary', home);
    for (const path of [parent, child, unreadable]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{}\n');
    }
    await writeFile(join(dirname(parent), 'summary.json'), JSON.stringify({ info: { cwd: '/work/repo' } }));
    await writeFile(join(dirname(child), 'summary.json'), JSON.stringify({ session_kind: 'subagent' }));
    await writeFile(join(dirname(unreadable), 'summary.json'), '{"partial');
    await utimes(unreadable, new Date(1_000), new Date(1_000));
    await utimes(parent, new Date(2_000), new Date(2_000));
    await utimes(child, new Date(3_000), new Date(3_000));

    await expect(latestGrokSessionId('/work/repo', home)).resolves.toBe('parent-session');
    await utimes(unreadable, new Date(4_000), new Date(4_000));
    await expect(latestGrokSessionId('/work/repo', home)).resolves.toBe('unreadable-summary');
  });

  it('tails appended JSONL once and waits for a complete line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-observer-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'updates.jsonl');
    const [first, ...rest] = twoTurnRecords();
    const partial = JSON.stringify(first);
    await writeFile(path, partial);

    const observer = createGrokSessionObserver(path, { pollIntervalMs: 60_000 });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));

    await observer.poll();
    expect(received).toHaveLength(0);

    await appendFile(path, `\n${rest.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    await observer.poll();
    const firstCount = received.length;
    await observer.poll();
    observer.stop();

    expect(firstCount).toBeGreaterThan(0);
    expect(received).toHaveLength(firstCount);
    expect(received.filter(({ event }) => event.type === 'turn:started')).toHaveLength(2);
    expect(received.filter(({ event }) => event.type === 'turn:completed')).toHaveLength(2);
    // Only the record straddling the first stat's size was there to replay: what came after it is live.
    expect(received.filter(({ phase }) => phase === 'bootstrap').map(({ event }) => event.type)).toEqual([
      'session:started',
      'adapter:native-event',
    ]);
    expect(received.at(2)?.phase).toBe('live');
  });

  it('settles what a replay left open before any live record, and marks a settled turn’s own end', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-replay-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'updates.jsonl');
    await writeFile(
      path,
      jsonl(
        userChunk('first', 1_784_669_125),
        thoughtChunk('P1'),
        record({ sessionUpdate: 'tool_call', toolCallId: 'T1', kind: 'read', status: 'in_progress' }, 'P1'),
        record({ sessionUpdate: 'subagent_spawned', subagent_id: 'S1' }, 'P1'),
        // A tool record ends a thought, so the one still open when the log stops comes after it.
        thoughtChunk('P1'),
      ),
    );
    const observer = createGrokSessionObserver(path, { pollIntervalMs: 60_000 });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    try {
      await observer.poll();
      const derived = received.filter(({ confidence }) => confidence === 'derived');
      expect(derived.map(({ event, promptId }) => [event, promptId])).toEqual([
        [{ type: 'tool:failed', toolCallId: 'T1', error: 'the session ended before this tool finished' }, 'P1'],
        [{ type: 'delegation:subagent-stopped', subagentId: 'S1' }, 'P1'],
        [{ type: 'reasoning:completed', reasoningId: 'P1' }, 'P1'],
        [{ type: 'turn:completed', turnId: 'P1' }, 'P1'],
        [{ type: 'adapter:native-event', adapter: 'grok', nativeType: 'replay.settled' }, undefined],
      ]);
      expect(derived.every(({ phase, source }) => phase === 'bootstrap' && source === 'runtime')).toBe(true);
      expect(received.at(-1)).toBe(derived.at(-1));

      const replayed = received.length;
      await appendFile(
        path,
        jsonl(
          userChunk('next', 1_784_669_126),
          thoughtChunk('P2'),
          record({ sessionUpdate: 'turn_completed', prompt_id: 'P1', stop_reason: 'end_turn' }),
        ),
      );
      await observer.poll();
      // The log's own end of the settled turn is the settle's duplicate, and comes alone and marked: control-session
      // publishes it only where a running frame started that prompt again.
      const live = received.slice(replayed);
      expect(live.map(({ event, phase, settledEnd }) => [event.type, phase, settledEnd === true])).toEqual([
        ['turn:started', 'live', false],
        ['reasoning:started', 'live', false],
        ['turn:completed', 'live', true],
      ]);
      expect(live.at(-1)?.event).toEqual({ type: 'turn:completed', turnId: 'P1', stopReason: 'end_turn' });
    } finally {
      observer.stop();
    }
  });

  it('gives a settled turn its own end once it shows live work, whichever record shows it', async () => {
    const liveWork = {
      message: record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }, 'P1'),
      thought: thoughtChunk('P1'),
      tool: record({ sessionUpdate: 'tool_call', toolCallId: 'T1', kind: 'read', status: 'in_progress' }, 'P1'),
    };
    for (const [name, work] of Object.entries(liveWork)) {
      const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-replay-reopen-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'updates.jsonl');
      await writeFile(path, jsonl(userChunk('first', 1_784_669_125), thoughtChunk('P1')));
      const observer = createGrokSessionObserver(path, { pollIntervalMs: 60_000 });
      const received: GrokObservedEvent[] = [];
      observer.onEvent((event) => received.push(event));
      try {
        await observer.poll();
        await appendFile(
          path,
          jsonl(work, record({ sessionUpdate: 'turn_completed', prompt_id: 'P1', stop_reason: 'end_turn' })),
        );
        await observer.poll();
        const ends = received.flatMap(({ event, phase }) =>
          event.type === 'turn:completed' ? [[event.stopReason, phase]] : [],
        );
        expect(ends, name).toEqual([
          [undefined, 'bootstrap'],
          ['end_turn', 'live'],
        ]);
      } finally {
        observer.stop();
      }
    }
  });

  it('ends a replayed refused turn without failing it, and fails a live one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-replay-refused-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'updates.jsonl');
    const message = record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'sorry' } }, 'P1');
    const refused = (prompt_id: string) =>
      record({ sessionUpdate: 'turn_completed', prompt_id, stop_reason: 'end_turn', error_kind: 'rate_limit' });
    await writeFile(path, jsonl(userChunk('old', 1_784_669_125), message, refused('P1')));
    const observer = createGrokSessionObserver(path, { pollIntervalMs: 60_000 });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    try {
      await observer.poll();
      await appendFile(path, jsonl(userChunk('new', 1_784_669_126), thoughtChunk('P2'), refused('P2')));
      await observer.poll();
      const ends = received.flatMap(({ event, phase }) =>
        event.type === 'turn:completed' || event.type === 'turn:failed' ? [[event.type, event.turnId, phase]] : [],
      );
      expect(ends).toEqual([
        ['turn:completed', 'P1', 'bootstrap'],
        ['turn:failed', 'P2', 'live'],
      ]);
      expect(received.find(({ event }) => event.type === 'turn:completed')?.event).toMatchObject({
        stopReason: 'end_turn',
        lastAssistantMessage: 'sorry',
      });
    } finally {
      observer.stop();
    }
  });

  it('starts a live turn from its own prompt, never the unanswered one the replay ended on', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-replay-prompt-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'updates.jsonl');
    await writeFile(path, jsonl(userChunk('old', 1_784_669_125)));
    const observer = createGrokSessionObserver(path, { pollIntervalMs: 60_000 });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    try {
      await observer.poll();
      await appendFile(path, jsonl(userChunk('new', 1_784_669_126), thoughtChunk('P2')));
      await observer.poll();
      expect(received.find(({ event }) => event.type === 'turn:started')).toMatchObject({
        phase: 'live',
        timestamp: new Date(1_784_669_126_000).toISOString(),
        event: { turnId: 'P2', prompt: 'new' },
      });
    } finally {
      observer.stop();
    }
  });

  it('reads a record appended during a bounded replay as live, and never settles it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-replay-bounded-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'updates.jsonl');
    const tool = (toolCallId: string) =>
      record({ sessionUpdate: 'tool_call', toolCallId, kind: 'read', status: 'in_progress' }, 'P1');
    await writeFile(path, jsonl(tool('T1')));
    const observer = createGrokSessionObserver(path, {
      pollIntervalMs: 60_000,
      readChunkBytes: 64,
      maxBytesPerPoll: 64,
    });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    try {
      await observer.poll();
      expect(received).toEqual([]);
      await appendFile(path, jsonl(tool('T2')));
      for (let poll = 0; poll < 20; poll += 1) await observer.poll();
      expect(received.map(({ event, phase }) => [event.type, phase])).toEqual([
        ['tool:started', 'bootstrap'],
        ['tool:failed', 'bootstrap'],
        ['adapter:native-event', 'bootstrap'],
        ['tool:started', 'live'],
      ]);
      expect(received.at(1)?.event).toMatchObject({ toolCallId: 'T1' });
      expect(received.at(-1)?.event).toMatchObject({ toolCallId: 'T2' });
    } finally {
      observer.stop();
    }
  });

  it('marks a log created after the initial observation boundary as live', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-live-observer-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'updates.jsonl');
    const observer = createGrokSessionObserver(path, { pollIntervalMs: 60_000 });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));

    await observer.poll();
    await writeFile(
      path,
      `${JSON.stringify(record({ sessionUpdate: 'hook_execution', event_name: 'session_start' }))}\n`,
    );
    await observer.poll();
    observer.stop();

    expect(received).toEqual([
      expect.objectContaining({
        phase: 'live',
        event: expect.objectContaining({ type: 'session:started' }),
      }),
    ]);
  });

  /**
   * A binding starts its observer's first poll at adoption without awaiting it, and a host submits its prompt as soon
   * as the binding is back, so the prompt's first records can be on disk before that poll looks. The replay boundary
   * is the log's size when the session was opened: a line drawn at the first poll's stat would replay those records,
   * and the settle would end the live turn without its text (main's red since #72, the grok conformance turn).
   */
  async function freshFirstTurn(open: (path: string) => GrokSessionObserver): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-boundary-fresh-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'updates.jsonl');
    // Adoption: a fresh session has no log yet.
    const observer = open(path);
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    const turn = imposterTurn('P1', 'do the thing');
    try {
      // The echo and the answer land before the first poll looks, and the end after it.
      await writeFile(path, jsonl(turn.user, turn.answer));
      await observer.poll();
      await appendFile(path, jsonl(turn.end));
      await observer.poll();

      expect(received.filter(({ phase }) => phase !== 'live').map(({ event }) => event.type)).toEqual([]);
      expect(received.map(({ nativeEvent }) => nativeEvent)).not.toContainEqual({ code: 'grok-replay-settled' });
      expect(received.map(({ event }) => event)).toContainEqual(
        expect.objectContaining({ type: 'conversation:assistant-message', text: 'imposter: ok', final: true }),
      );
      expect(received.at(-1)?.event).toEqual({
        type: 'turn:completed',
        turnId: 'P1',
        stopReason: 'end_turn',
        lastAssistantMessage: 'imposter: ok',
      });
      expect(received.at(-1)?.settledEnd).toBeUndefined();
    } finally {
      observer.stop();
    }
  }

  it('reads a fresh session’s first turn as live when it lands before the first poll (boundary 0)', async () => {
    await freshFirstTurn((path) => createGrokSessionObserver(path, { pollIntervalMs: 60_000, replayBoundary: 0 }));
  });

  it('reads a fresh session’s first turn as live when it lands before the first poll (no boundary)', async () => {
    await freshFirstTurn((path) => createGrokSessionObserver(path, { pollIntervalMs: 60_000 }));
  });

  /**
   * A resume: its history is on disk when the session opens, and its next turn lands before the first poll looks.
   * `relocated`: the observer is pointed at another cwd's bucket than the one that holds the session, as when a
   * session is resumed from a new cwd, so it finds the session by its summary.json.
   */
  async function resumedNextTurn(
    open: (path: string, boundary: number) => GrokSessionObserver,
    { relocated = false }: { relocated?: boolean } = {},
  ): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'puppeteer-grok-boundary-resume-'));
    temporaryDirectories.push(home);
    const path = grokUpdatesPath('/work/repo', 'resumed-session', home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(join(dirname(path), 'summary.json'), '{}');
    const history = imposterTurn('P1', 'before resume');
    const next = imposterTurn('P2', 'after resume');
    const written = jsonl(history.user, history.answer, history.end);
    await writeFile(path, written);
    // Adoption, at the log's size when the session was opened.
    const observer = open(
      relocated ? grokUpdatesPath('/work/elsewhere', 'resumed-session', home) : path,
      Buffer.byteLength(written),
    );
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    try {
      await appendFile(path, jsonl(next.user, next.answer));
      await observer.poll();
      await appendFile(path, jsonl(next.end));
      await observer.poll();

      const starts = received.flatMap(({ event, phase }) =>
        event.type === 'turn:started' ? [[event.turnId, phase]] : [],
      );
      expect(starts).toEqual([
        ['P1', 'bootstrap'],
        ['P2', 'live'],
      ]);
      const ends = received.flatMap(({ event, phase, settledEnd }) =>
        event.type === 'turn:completed' ? [[event.turnId, phase, event.lastAssistantMessage, settledEnd === true]] : [],
      );
      expect(ends).toEqual([
        ['P1', 'bootstrap', 'imposter: ok', false],
        ['P2', 'live', 'imposter: ok', false],
      ]);
    } finally {
      observer.stop();
    }
  }

  it('reads a resume’s next turn as live when it lands before the first poll (boundary at open)', async () => {
    await resumedNextTurn((path, boundary) =>
      createGrokSessionObserver(path, { pollIntervalMs: 60_000, replayBoundary: boundary }),
    );
  });

  it('reads a resume’s next turn as live when it lands before the first poll (no boundary)', async () => {
    await resumedNextTurn((path) => createGrokSessionObserver(path, { pollIntervalMs: 60_000 }));
  });

  it('reads a relocated resume’s next turn as live when it lands before the first poll (no boundary)', async () => {
    await resumedNextTurn((path) => createGrokSessionObserver(path, { pollIntervalMs: 60_000 }), { relocated: true });
  });

  it('reads historic logs in bounded chunks and skips an oversized record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-bounded-observer-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'updates.jsonl');
    const oversized = JSON.stringify({
      ...((record({ sessionUpdate: 'hook_execution', event_name: 'session_start' }) as object) ?? {}),
      padding: 'x'.repeat(4_096),
    });
    const valid = JSON.stringify(record({ sessionUpdate: 'hook_execution', event_name: 'session_start' }));
    await writeFile(path, `${oversized}\n${valid}\n`);

    const observer = createGrokSessionObserver(path, {
      pollIntervalMs: 60_000,
      readChunkBytes: 64,
      maxRecordBytes: 512,
      maxBytesPerPoll: 8_192,
    });
    const received: GrokObservedEvent[] = [];
    const errors: Error[] = [];
    observer.onEvent((event) => received.push(event));
    observer.onError((error) => errors.push(error));

    await observer.poll();
    observer.stop();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('512-byte safety limit');
    expect(received.map(({ event }) => event.type)).toEqual(['session:started', 'adapter:native-event']);
  });

  it('reads exact context usage from signals.json, retries partial rewrites, and deduplicates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-signals-'));
    temporaryDirectories.push(directory);
    const updatesPath = join(directory, 'updates.jsonl');
    const signalsPath = join(directory, 'signals.json');
    await writeFile(updatesPath, '');
    await writeFile(signalsPath, '{"contextTokensUsed":');

    const observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000, signalsPath });
    const received: GrokObservedEvent[] = [];
    const errors: Error[] = [];
    observer.onEvent((event) => received.push(event));
    observer.onError((error) => errors.push(error));

    await observer.poll();
    expect(received).toEqual([]);
    expect(errors).toEqual([]);

    await writeFile(
      signalsPath,
      JSON.stringify({
        contextWindowUsage: 3,
        contextTokensUsed: 18_415,
        contextWindowTokens: 500_000,
        primaryModelId: 'grok-4.5',
        compactionCount: 0,
      }),
    );
    await observer.poll();
    await observer.poll();
    observer.stop();

    expect(received).toEqual([
      {
        event: {
          type: 'context-window:updated',
          usedTokens: 18_415,
          capacityTokens: 500_000,
          modelId: 'grok-4.5',
        },
        phase: 'live',
        source: 'native-log',
        confidence: 'authoritative',
        nativeEvent: expect.objectContaining({ contextWindowUsage: 3, compactionCount: 0 }),
      },
    ]);
  });

  it('invalidates a compacted context when the replacement measurement is temporarily absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-compaction-'));
    temporaryDirectories.push(directory);
    const updatesPath = join(directory, 'updates.jsonl');
    const signalsPath = join(directory, 'signals.json');
    await writeFile(updatesPath, '');
    await writeFile(
      signalsPath,
      JSON.stringify({ contextTokensUsed: 100, contextWindowTokens: 1_000, compactionCount: 0 }),
    );

    const observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000, signalsPath });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    await observer.poll();
    await writeFile(signalsPath, JSON.stringify({ compactionCount: 1 }));
    await observer.poll();
    await writeFile(
      signalsPath,
      JSON.stringify({ contextTokensUsed: 100, contextWindowTokens: 1_000, compactionCount: 1 }),
    );
    await observer.poll();
    observer.stop();

    expect(received.map(({ event }) => event)).toEqual([
      { type: 'context-window:updated', usedTokens: 100, capacityTokens: 1_000, modelId: undefined },
      { type: 'context-window:invalidated', reason: 'compacted' },
      { type: 'context-window:updated', usedTokens: 100, capacityTokens: 1_000, modelId: undefined },
    ]);
  });

  it('reads authoritative cwd and current model from summary.json and deduplicates them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'puppeteer-grok-summary-'));
    temporaryDirectories.push(directory);
    const updatesPath = join(directory, 'updates.jsonl');
    const summaryPath = join(directory, 'summary.json');
    await writeFile(updatesPath, '');
    await writeFile(summaryPath, JSON.stringify({ info: { cwd: '/repo' }, current_model_id: 'grok-4.5' }));

    const observer = createGrokSessionObserver(updatesPath, { pollIntervalMs: 60_000, summaryPath });
    const received: GrokObservedEvent[] = [];
    observer.onEvent((event) => received.push(event));
    await observer.poll();
    await observer.poll();
    observer.stop();

    expect(received).toEqual([
      {
        event: { type: 'environment:updated', currentCwd: '/repo' },
        phase: 'bootstrap',
        source: 'native-log',
        confidence: 'authoritative',
        nativeEvent: { info: { cwd: '/repo' }, current_model_id: 'grok-4.5' },
      },
      {
        event: { type: 'model:updated', model: { id: 'grok-4.5', provider: 'xai' } },
        phase: 'bootstrap',
        source: 'native-log',
        confidence: 'authoritative',
        nativeEvent: { info: { cwd: '/repo' }, current_model_id: 'grok-4.5' },
      },
    ]);
  });
});
