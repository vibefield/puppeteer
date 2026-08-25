import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGrokSessionObserver,
  grokExtensionEvents,
  grokUpdatesPath,
  GrokUpdateNormalizer,
  latestGrokSessionId,
  type GrokObservedEvent,
} from './session-observer.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(update: Record<string, unknown>, promptId?: string): unknown {
  return {
    timestamp: 1_784_669_125_000,
    method:
      update.sessionUpdate === 'turn_completed' || update.sessionUpdate === 'hook_execution'
        ? '_x.ai/session/update'
        : 'session/update',
    params: {
      sessionId: 'grok-session',
      update,
      _meta: promptId ? { promptId, agentTimestampMs: 1_784_669_125_000 } : undefined,
    },
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
  it('preserves the nested identity of live xAI extension notifications', () => {
    expect(
      grokExtensionEvents('_x.ai/session_notification', {
        sessionId: 'grok-session',
        update: { sessionUpdate: 'auto_compact_started' },
      }),
    ).toEqual([{ type: 'adapter.native-event', adapter: 'grok', nativeType: 'auto_compact_started' }]);
  });

  it('frames two terminal-authored turns with stable, distinct message identities', () => {
    const normalizer = new GrokUpdateNormalizer();
    const events = twoTurnRecords().flatMap((entry) => normalizer.normalize(entry));

    expect(events.filter(({ event }) => event.type === 'turn.started').map(({ event }) => event)).toEqual([
      { type: 'turn.started', turnId: 'prompt-1', prompt: 'first question' },
      { type: 'turn.started', turnId: 'prompt-2', prompt: 'second question' },
    ]);
    const assistant = events
      .filter(({ event }) => event.type === 'assistant.message' && event.final)
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
    expect(events.filter(({ event }) => event.type === 'turn.completed').map(({ promptId }) => promptId)).toEqual([
      'prompt-1',
      'prompt-2',
    ]);
    expect(events.some(({ event }) => event.type === 'reasoning.summary')).toBe(false);
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
      { type: 'turn.started', turnId: 'real-prompt', prompt: 'hookless question' },
      expect.objectContaining({
        type: 'assistant.message',
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
      { type: 'subagent.started', subagentId: 'child-1', agentType: 'explore' },
    ]);
    expect(progress.map(({ event }) => event)).toEqual([
      { type: 'adapter.native-event', adapter: 'grok', nativeType: 'subagent_progress' },
    ]);
    expect(stopped.map(({ event }) => event)).toEqual([{ type: 'subagent.stopped', subagentId: 'child-1' }]);
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
          event: { type: 'adapter.native-event', adapter: 'grok', nativeType },
        }),
      ),
    );
  });
});

describe('createGrokSessionObserver', () => {
  it('resolves bare --resume to the most recently updated cwd-scoped session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chopsticks-grok-home-'));
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

  it('tails appended JSONL once and waits for a complete line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chopsticks-grok-observer-'));
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
    expect(received.filter(({ event }) => event.type === 'turn.started')).toHaveLength(2);
    expect(received.filter(({ event }) => event.type === 'turn.completed')).toHaveLength(2);
    expect(received.every(({ phase }) => phase === 'bootstrap')).toBe(true);
  });

  it('marks a log created after the initial observation boundary as live', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chopsticks-grok-live-observer-'));
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
        event: expect.objectContaining({ type: 'session.started' }),
      }),
    ]);
  });

  it('reads historic logs in bounded chunks and skips an oversized record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chopsticks-grok-bounded-observer-'));
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
    expect(received.map(({ event }) => event.type)).toEqual(['session.started']);
  });

  it('reads exact context usage from signals.json, retries partial rewrites, and deduplicates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chopsticks-grok-signals-'));
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
          type: 'context-window.updated',
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
    const directory = await mkdtemp(join(tmpdir(), 'chopsticks-grok-compaction-'));
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
    observer.stop();

    expect(received.map(({ event }) => event)).toEqual([
      { type: 'context-window.updated', usedTokens: 100, capacityTokens: 1_000, modelId: undefined },
      { type: 'context-window.invalidated', reason: 'compacted' },
    ]);
  });

  it('reads authoritative cwd and current model from summary.json and deduplicates them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chopsticks-grok-summary-'));
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
        event: {
          type: 'session.environment.updated',
          currentCwd: '/repo',
          model: { id: 'grok-4.5', provider: 'xai' },
        },
        phase: 'bootstrap',
        source: 'native-log',
        confidence: 'authoritative',
        nativeEvent: { info: { cwd: '/repo' }, current_model_id: 'grok-4.5' },
      },
    ]);
  });
});
