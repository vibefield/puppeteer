import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SemanticObservationEvent, SemanticObservationHandle } from '../semantic-provider.js';
import { ClaudeTranscriptObservationProvider } from './provider.js';
import * as sessionReader from './services/session-reader.js';
import { decodeClaudeTranscript } from './wire.js';

const roots: string[] = [];
const handles: SemanticObservationHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.dispose()));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function usageRow(
  sequence: number,
  options: { requestId?: string; tokens?: number; model?: string; agentId?: string; agentType?: string } = {},
): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid: `message-${sequence}`,
      sessionId: 'session-1',
      requestId: options.requestId ?? 'request-1',
      timestamp: new Date(Date.parse('2026-08-25T16:30:00.000Z') + sequence * 1_000).toISOString(),
      agentId: options.agentId,
      agentType: options.agentType,
      message: {
        role: 'assistant',
        model: options.model ?? 'model-a',
        content: [],
        usage: { input_tokens: 10, output_tokens: options.tokens ?? sequence },
      },
    }) + '\n'
  );
}

async function fixture(contents: string) {
  const root = mkdtempSync(join(tmpdir(), 'claude-transcript-regression-'));
  roots.push(root);
  const path = join(root, 'session-1.jsonl');
  writeFileSync(path, contents);
  const handle = await new ClaudeTranscriptObservationProvider().attach({
    nativeSessionId: 'session-1',
    transcriptPath: path,
    pollIntervalMs: 0,
  });
  handles.push(handle);
  const events: SemanticObservationEvent[] = [];
  handle.onEvent((event) => events.push(event));
  return { root, path, handle, events };
}

describe('ClaudeTranscriptObservationProvider', () => {
  it.each(['\n', ''])('baselines existing messages with EOF=%j and publishes only later changes', async (ending) => {
    const row = (type: 'user' | 'assistant', id: string, text: string) =>
      JSON.stringify({
        type,
        uuid: id,
        sessionId: 'session-1',
        timestamp: '2026-09-11T16:30:00.000Z',
        message: { role: type, content: text },
      });
    const { path, handle, events } = await fixture(
      row('user', 'old-prompt', 'Old prompt') + '\n' + row('assistant', 'old-reply', 'Old reply') + ending,
    );
    await handle.poll();
    await handle.poll();
    expect(events).toEqual([]);

    appendFileSync(
      path,
      '\n' + row('user', 'new-prompt', 'New prompt') + '\n' + row('assistant', 'new-reply', 'New reply') + '\n',
    );
    await handle.poll();
    expect(events).toEqual([
      expect.objectContaining({
        turnId: 'new-prompt',
        event: {
          type: 'conversation:assistant-message',
          messageId: 'new-reply',
          turnId: 'new-prompt',
          text: 'New reply',
          final: true,
          displayOnly: false,
        },
      }),
    ]);
    expect(events[0]?.replay).toBeUndefined();
    events.length = 0;
    appendFileSync(path, JSON.stringify({ type: 'attachment', uuid: 'metadata' }) + '\n');
    await handle.poll();
    expect(events.map(({ event }) => event.type)).toEqual(['adapter:native-event']);

    const rebound = await new ClaudeTranscriptObservationProvider().attach({
      nativeSessionId: 'session-1',
      transcriptPath: path,
      pollIntervalMs: 0,
    });
    handles.push(rebound);
    const reboundEvents: SemanticObservationEvent[] = [];
    rebound.onEvent((event) => reboundEvents.push(event));
    await rebound.poll();
    expect(reboundEvents.map(({ event }) => event.type)).toEqual(['adapter:native-event']);
  });

  it('compares final actor models once without publishing transcript usage', async () => {
    const { path, handle, events } = await fixture(
      usageRow(1) + usageRow(2, { model: 'model-b' }) + usageRow(3, { requestId: 'request-2' }),
    );
    await handle.poll();
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'model:updated', model: { id: 'model-a', provider: 'anthropic' } }),
    ]);
    expect(events.every(({ replay }) => replay)).toBe(true);
    events.length = 0;
    await handle.poll();
    await handle.poll();
    expect(events).toEqual([]);

    // Force a new snapshot too: silence must come from correct deduplication,
    // not only the reader's unchanged-file shortcut.
    appendFileSync(path, JSON.stringify({ type: 'attachment', uuid: 'metadata' }) + '\n');
    await handle.poll();
    expect(events.map(({ event }) => event.type)).toEqual(['adapter:native-event']);
    events.length = 0;

    appendFileSync(path, usageRow(4, { tokens: 1, model: 'model-c' }));
    await handle.poll();
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'model:updated', model: { id: 'model-c', provider: 'anthropic' } }),
    ]);
    expect(events.every(({ replay }) => !replay)).toBe(true);
    events.length = 0;
    await handle.poll();
    expect(events).toEqual([]);
  });

  it('retains child models without publishing usage from child sidecars or later root copies', async () => {
    const { root, path, handle, events } = await fixture(usageRow(2));
    await handle.poll();
    events.length = 0;
    const children = join(root, 'session-1', 'subagents');
    mkdirSync(children, { recursive: true });
    writeFileSync(
      join(children, 'agent-worker.jsonl'),
      usageRow(1, {
        tokens: 2,
        agentId: 'worker',
        agentType: 'researcher',
        model: 'child-model',
      }),
    );
    await handle.poll();
    expect(events.filter(({ event }) => event.type === 'usage:tokens-used')).toEqual([]);
    expect(events.filter(({ event }) => event.type === 'model:updated')).toEqual([
      expect.objectContaining({
        agentId: 'worker',
        event: expect.objectContaining({ model: { id: 'child-model', provider: 'anthropic' } }),
      }),
    ]);
    events.length = 0;
    appendFileSync(path, usageRow(3, { tokens: 4 }));
    await handle.poll();
    expect(events).toEqual([]);
    events.length = 0;
    await handle.poll();
    expect(events).toEqual([]);
  });

  it('continues workflow polling while the transcript snapshot is unchanged', async () => {
    const { root, handle, events } = await fixture(usageRow(1));
    await handle.poll();
    events.length = 0;
    const directory = join(root, 'session-1', 'subagents', 'workflows', 'workflow-1');
    mkdirSync(directory, { recursive: true });
    const journal = join(directory, 'journal.jsonl');
    writeFileSync(journal, JSON.stringify({ type: 'started', agentId: 'worker' }) + '\n');
    await handle.poll();
    appendFileSync(journal, JSON.stringify({ type: 'result', agentId: 'worker' }) + '\n');
    await handle.poll();
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'workflow:updated', active: true }),
      expect.objectContaining({ type: 'workflow:updated', active: false }),
    ]);
  });

  it('allows other event-loop work to run before a large replay finishes', async () => {
    const count = 2_000;
    const { handle, events } = await fixture(
      Array.from({ length: count }, (_, index) =>
        JSON.stringify({ type: 'attachment', uuid: `metadata-${index}` }),
      ).join('\n') + '\n',
    );
    let deliveredAtYield = 0;
    handle.onEvent(() => {
      if (events.length === 1)
        setImmediate(() => {
          deliveredAtYield = events.length;
        });
    });
    await handle.poll();
    expect(events).toHaveLength(count);
    expect(deliveredAtYield).toBeGreaterThan(0);
    expect(deliveredAtYield).toBeLessThan(count);
    expect(events.every(({ replay }) => replay)).toBe(true);
  });

  it('stops replay delivery when disposed during a yielded batch', async () => {
    const { handle, events } = await fixture(
      Array.from({ length: 2_000 }, (_, index) =>
        JSON.stringify({ type: 'attachment', uuid: `metadata-${index}` }),
      ).join('\n') + '\n',
    );
    let disposal: Promise<void> | undefined;
    handle.onEvent(() => {
      if (events.length === 1)
        setImmediate(() => {
          disposal = handle.dispose();
        });
    });
    await handle.poll();
    await disposal;
    const delivered = events.length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(2_000);
    await handle.poll();
    expect(events).toHaveLength(delivered);
  });

  it('merges concurrent hints into one follow-up read and waits for its newer data', async () => {
    let release!: (snapshot: sessionReader.ClaudeSessionTranscriptSnapshot) => void;
    const updated = decodeClaudeTranscript(usageRow(1));
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue({ root: updated, all: updated });
    vi.spyOn(sessionReader, 'createClaudeSessionTranscriptReader').mockReturnValue({ read });
    const { handle, events } = await fixture('');
    const first = handle.poll();
    await Promise.resolve();
    const hinted = Array.from({ length: 100 }, () => handle.poll({ hookEventName: 'Stop' }));
    release({ root: [], all: [] });
    await Promise.all([first, ...hinted]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'model:updated', model: { id: 'model-a', provider: 'anthropic' } }),
    ]);
  });

  it('observes model and workflow snapshots without replaying historical conversation or usage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-transcript-provider-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: 'user',
          uuid: 'prompt-1',
          timestamp: '2026-08-25T16:30:00.000Z',
          sessionId,
          isSidechain: false,
          message: { role: 'user', content: [{ type: 'text', text: 'What changed?' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          requestId: 'request-1',
          timestamp: '2026-08-25T16:30:01.000Z',
          sessionId,
          isSidechain: false,
          message: {
            id: 'message-1',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'The observer is modular.' }],
            usage: {
              input_tokens: 12,
              output_tokens: 4,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 2,
            },
          },
        }),
        '{crash-mid-write',
      ].join('\n'),
    );
    const workflowDirectory = join(root, sessionId, 'subagents', 'workflows', 'workflow-1');
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(
      join(workflowDirectory, 'journal.jsonl'),
      [
        JSON.stringify({ type: 'started', agentId: 'worker-a', agentType: 'researcher' }),
        JSON.stringify({ type: 'started', agentId: 'worker-b', agentType: 'reviewer' }),
        JSON.stringify({ type: 'result', agentId: 'worker-a' }),
      ].join('\n') + '\n',
    );

    const provider = new ClaudeTranscriptObservationProvider();
    const handle = await provider.attach({ nativeSessionId: sessionId, transcriptPath });
    const events: SemanticObservationEvent[] = [];
    handle.onEvent((event) => events.push(event));
    await handle.poll();

    expect(events.filter(({ replay }) => replay).map(({ event }) => event.type)).toEqual([
      'model:updated',
      'workflow:updated',
    ]);
    expect((await provider.capabilities()).some(({ family }) => family === 'usage')).toBe(false);
    expect(events.find(({ event }) => event.type === 'workflow:updated')?.event).toEqual({
      type: 'workflow:updated',
      workflowId: 'workflow-1',
      active: true,
      members: [
        { agentId: 'worker-a', agentType: 'researcher', state: 'completed' },
        { agentId: 'worker-b', agentType: 'reviewer', state: 'active' },
      ],
    });

    const count = events.length;
    await handle.poll();
    expect(events).toHaveLength(count);
    await handle.dispose();
  });

  it('reads exact-session child models without replaying child conversation or usage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-transcript-descendants-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, '');
    const subagents = join(root, 'subagents');
    mkdirSync(subagents);
    const assistant = (recordSessionId: string, requestId: string, agentId: string) =>
      `${JSON.stringify({
        type: 'assistant',
        uuid: `${requestId}-message`,
        requestId,
        timestamp: '2026-08-25T16:30:01.000Z',
        sessionId: recordSessionId,
        agentId,
        agentType: 'researcher',
        isSidechain: true,
        message: {
          role: 'assistant',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'Child-only answer' }],
          usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 20 },
        },
      })}\n`;
    writeFileSync(join(subagents, 'agent-worker.jsonl'), assistant(sessionId, 'request-child', 'worker'));
    writeFileSync(join(subagents, 'agent-foreign.jsonl'), assistant('session-foreign', 'request-foreign', 'intruder'));

    const provider = new ClaudeTranscriptObservationProvider();
    const handle = await provider.attach({ nativeSessionId: sessionId, transcriptPath });
    const events: SemanticObservationEvent[] = [];
    handle.onEvent((event) => events.push(event));
    await handle.poll();

    expect(events.filter(({ event }) => event.type === 'conversation:assistant-message')).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({
        agentId: 'worker',
        agentType: 'researcher',
        replay: true,
        event: { type: 'model:updated', intent: 'observed', model: { id: 'claude-haiku-4-5', provider: 'anthropic' } },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('request-foreign');
    await handle.dispose();
  });

  it('continues workflow observation when transcript reading fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-transcript-isolation-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, 'transcript.jsonl');
    mkdirSync(transcriptPath);
    const workflowDirectory = join(root, sessionId, 'subagents', 'workflows', 'workflow-1');
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(
      join(workflowDirectory, 'journal.jsonl'),
      `${JSON.stringify({ type: 'started', agentId: 'worker-a' })}\n`,
    );
    const provider = new ClaudeTranscriptObservationProvider();
    const handle = await provider.attach({ nativeSessionId: sessionId, transcriptPath });
    const events: SemanticObservationEvent[] = [];
    const errors: Error[] = [];
    handle.onEvent((event) => events.push(event));
    handle.onError((error) => errors.push(error));

    await handle.poll();

    expect(errors).toHaveLength(1);
    expect(events.find(({ event }) => event.type === 'workflow:updated')?.event).toMatchObject({
      workflowId: 'workflow-1',
      active: true,
    });
    await handle.dispose();
  });
});
