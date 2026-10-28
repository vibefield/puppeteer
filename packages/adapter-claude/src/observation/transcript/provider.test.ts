import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SemanticObservationEvent, SemanticObservationHandle } from '../semantic-provider.js';
import { ClaudeTranscriptObservationProvider } from './provider.js';
import * as jsonlReader from './services/jsonl-reader.js';
import { decodeClaudeTranscript, type ClaudeTranscriptRecord } from './wire.js';
import { claude2308TranscriptRows, claude2308TranscriptText } from '../../test-support/claude-transcript-fixtures.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
    stat: vi.fn(actual.stat),
    open: vi.fn(actual.open),
  };
});

const roots: string[] = [];
const handles: SemanticObservationHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.dispose()));
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assistantRow(
  sequence: number,
  options: {
    requestId?: string;
    tokens?: number;
    model?: string;
    agentId?: string;
    agentType?: string;
    text?: string;
    sessionId?: string | null;
  } = {},
): string {
  return (
    JSON.stringify({
      type: 'assistant',
      uuid: `message-${sequence}`,
      sessionId: options.sessionId === null ? undefined : (options.sessionId ?? 'session-1'),
      requestId: options.requestId ?? 'request-1',
      timestamp: new Date(Date.parse('2026-08-25T16:30:00.000Z') + sequence * 1_000).toISOString(),
      agentId: options.agentId,
      agentType: options.agentType,
      message: {
        role: 'assistant',
        model: options.model ?? 'model-a',
        content: options.text ?? [],
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
    expect(events).toEqual([]);

    const rebound = await new ClaudeTranscriptObservationProvider().attach({
      nativeSessionId: 'session-1',
      transcriptPath: path,
      pollIntervalMs: 0,
    });
    handles.push(rebound);
    const reboundEvents: SemanticObservationEvent[] = [];
    rebound.onEvent((event) => reboundEvents.push(event));
    await rebound.poll();
    expect(reboundEvents).toEqual([]);
  });

  it("reads an attached session's open work once: its turn and tool as replay, the question it waits on live", async () => {
    const sessionId = 'session-1';
    const finished = claude2308TranscriptRows(
      [{ promptUuid: 'prompt-1', prompt: 'List the files', answer: 'Two files.', tool: true }],
      { sessionId },
    );
    // the agent asked a question in its next turn, and the host restarted before anyone answered
    const asking = [
      {
        type: 'user',
        uuid: 'prompt-2',
        parentUuid: 'prompt-1-duration',
        promptId: 'prompt-prompt-2',
        turnOrigin: 'human',
        isSidechain: false,
        sessionId,
        timestamp: '2026-10-27T12:00:00.000Z',
        message: { role: 'user', content: 'Pick a branch and ship' },
      },
      {
        type: 'assistant',
        uuid: 'prompt-2-ask',
        parentUuid: 'prompt-2',
        isSidechain: false,
        sessionId,
        timestamp: '2026-10-27T12:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-ask',
              name: 'AskUserQuestion',
              input: { questions: [{ question: 'Which branch?', options: [{ label: 'main' }] }] },
            },
          ],
        },
      },
    ];
    const root = mkdtempSync(join(tmpdir(), 'claude-transcript-attach-'));
    roots.push(root);
    const path = join(root, 'session-1.jsonl');
    writeFileSync(path, [...finished, ...asking].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const read = async (attached: boolean) => {
      const handle = await new ClaudeTranscriptObservationProvider().attach({
        nativeSessionId: sessionId,
        transcriptPath: path,
        pollIntervalMs: 0,
        ...(attached ? { attached: true } : {}),
      });
      handles.push(handle);
      const events: SemanticObservationEvent[] = [];
      handle.onEvent((event) => events.push(event));
      await handle.poll();
      return { handle, events };
    };

    const { handle, events } = await read(true);
    expect(events.map(({ event, replay, openAtAttach }) => ({ type: event.type, replay, openAtAttach }))).toEqual([
      { type: 'turn:started', replay: true, openAtAttach: true },
      { type: 'tool:requested', replay: true, openAtAttach: true },
      // replay notifies nobody: the question the agent waits on is announced live, after the state it belongs to
      { type: 'interaction:question-requested', replay: undefined, openAtAttach: true },
    ]);
    expect(events[0]?.event).toEqual({
      type: 'turn:started',
      turnId: 'prompt-prompt-2',
      prompt: 'Pick a branch and ship',
    });
    expect(events[1]?.event).toMatchObject({ toolCallId: 'toolu-ask', tool: 'AskUserQuestion' });
    expect(events[2]?.event).toMatchObject({ requestId: 'question:toolu-ask' });
    // once: a later read publishes only what changed, and the finished turn's reply stays the silent baseline
    events.length = 0;
    appendFileSync(path, JSON.stringify({ type: 'attachment', uuid: 'later' }) + '\n');
    await handle.poll();
    expect(events).toEqual([]);
    // a launch, a resume or a rebind reads the same transcript as its silent baseline
    expect((await read(false)).events).toEqual([]);
  });

  it('publishes one live reply per 2.1.308 turn, keyed to its prompt, across request bookkeeping', async () => {
    const sessionId = 'session-1';
    const history = [{ promptUuid: 'prompt-1', prompt: 'List the files', answer: 'Two files.', tool: true }];
    const { path, handle, events } = await fixture(claude2308TranscriptText(history, { sessionId }));
    await handle.poll();
    expect(events).toEqual([]);

    // Append the next turn exactly as the session file grows: only its rows are new.
    const next = { promptUuid: 'prompt-2', prompt: 'Summarize them', answer: 'Both are notes.', tool: true };
    const before = claude2308TranscriptRows(history, { sessionId }).length;
    const grown = claude2308TranscriptRows([...history, next], { sessionId });
    appendFileSync(
      path,
      grown
        .slice(before)
        .map((row) => JSON.stringify(row))
        .join('\n')
        .concat('\n'),
    );
    await handle.poll();
    expect(events.map(({ turnId, event }) => ({ turnId, event }))).toEqual([
      {
        turnId: 'prompt-2',
        event: {
          type: 'conversation:assistant-message',
          messageId: 'prompt-2-answer',
          turnId: 'prompt-2',
          text: 'Both are notes.',
          final: true,
          displayOnly: false,
        },
      },
    ]);
    // Trailing bookkeeping re-announces nothing.
    events.length = 0;
    appendFileSync(path, `${JSON.stringify({ type: 'cost-state', modelUsage: {}, totalCostUSD: 0, sessionId })}\n`);
    await handle.poll();
    expect(events).toEqual([]);
  });

  it('ignores transcript models and usage during attachment and later changes', async () => {
    const { path, handle, events } = await fixture(
      assistantRow(1) + assistantRow(2, { model: 'model-b' }) + assistantRow(3, { requestId: 'request-2' }),
    );
    await handle.poll();
    await handle.poll();
    await handle.poll();
    expect(events).toEqual([]);

    appendFileSync(path, assistantRow(4, { tokens: 1, model: 'model-c' }));
    await handle.poll();
    expect(events).toEqual([]);

    appendFileSync(path, assistantRow(5, { model: 'model-d', text: 'New reply' }));
    await handle.poll();
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'conversation:assistant-message', text: 'New reply' }),
    ]);
    expect(events.every(({ replay }) => !replay)).toBe(true);
    events.length = 0;
    // Model/usage changes cannot republish an unchanged assistant message.
    appendFileSync(path, assistantRow(5, { model: 'model-e', tokens: 50, text: 'New reply' }));
    await handle.poll();
    expect(events).toEqual([]);
  });

  it('never discovers, probes or reads child transcripts, including later additions and malformed paths', async () => {
    const { root, path, handle, events } = await fixture(assistantRow(1));
    const children = [join(root, 'session-1', 'subagents'), join(root, 'subagents')];
    for (const directory of children) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'agent-worker.jsonl'),
        assistantRow(2, { agentId: 'worker', model: 'child-model' }),
      );
    }
    const listings = vi.mocked(fsPromises.readdir).mockClear();
    const probes = vi.mocked(fsPromises.lstat).mockClear();
    const stats = vi.mocked(fsPromises.stat).mockClear();
    const opens = vi.mocked(fsPromises.open).mockClear();
    const errors: Error[] = [];
    handle.onError((error) => errors.push(error));

    await handle.poll();
    expect(events).toEqual([]);
    for (const directory of children) {
      appendFileSync(
        join(directory, 'agent-worker.jsonl'),
        assistantRow(3, { agentId: 'worker', model: 'new-child-model' }),
      );
      writeFileSync(join(directory, 'agent-new.jsonl'), assistantRow(4, { agentId: 'new', text: 'Child reply' }));
    }
    await handle.poll();
    appendFileSync(path, assistantRow(3, { agentId: 'worker', model: 'copied-child-model' }));
    await handle.poll();
    expect(events).toEqual([]);

    for (const directory of children) {
      rmSync(directory, { recursive: true });
      writeFileSync(directory, 'not a directory');
    }
    appendFileSync(path, assistantRow(5, { text: 'Root reply' }));
    await handle.poll();
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'conversation:assistant-message', text: 'Root reply' }),
    ]);
    expect(errors).toEqual([]);
    expect(listings).not.toHaveBeenCalled();
    expect(probes).not.toHaveBeenCalled();
    expect(stats.mock.calls.every(([file]) => file === path)).toBe(true);
    expect(opens.mock.calls.every(([file]) => file === path)).toBe(true);
  });

  it('keeps root session filtering while accepting rows without a repeated session id', async () => {
    const { path, handle, events } = await fixture(assistantRow(1, { text: 'Old root reply' }));
    await handle.poll();
    appendFileSync(
      path,
      assistantRow(2, { sessionId: 'foreign-session', text: 'Foreign reply' }) +
        assistantRow(3, { text: 'Root reply' }) +
        assistantRow(4, { sessionId: null, text: 'Root reply without repeated identity' }),
    );
    await handle.poll();
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'conversation:assistant-message', text: 'Root reply' }),
      expect.objectContaining({ type: 'conversation:assistant-message', text: 'Root reply without repeated identity' }),
    ]);
  });

  it('does not read workflow journals at attachment or on later polls', async () => {
    const { root, path, handle, events } = await fixture(assistantRow(1));
    const workflowRoot = join(root, 'session-1', 'subagents', 'workflows');
    const directory = join(workflowRoot, 'workflow-1');
    mkdirSync(directory, { recursive: true });
    const journal = join(directory, 'journal.jsonl');
    writeFileSync(journal, JSON.stringify({ type: 'started', agentId: 'worker' }) + '\n');
    const listings = vi.mocked(fsPromises.readdir).mockClear();
    const opens = vi.mocked(fsPromises.open).mockClear();
    const errors: Error[] = [];
    handle.onError((error) => errors.push(error));

    await handle.poll();
    expect(events).toEqual([]);
    appendFileSync(journal, JSON.stringify({ type: 'result', agentId: 'worker' }) + '\n');
    await handle.poll();
    expect(events).toEqual([]);

    // An invalid workflow directory cannot affect transcript observation.
    rmSync(workflowRoot, { recursive: true });
    writeFileSync(workflowRoot, 'not a directory');
    appendFileSync(path, assistantRow(2, { model: 'new-model', text: 'New reply' }));
    await handle.poll();
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'conversation:assistant-message', text: 'New reply' }),
    ]);
    expect(errors).toEqual([]);
    expect(
      [...listings.mock.calls, ...opens.mock.calls].filter(([path]) => String(path).startsWith(workflowRoot)),
    ).toEqual([]);
  });

  it('allows other event-loop work to run before a large live assistant batch finishes', async () => {
    const count = 2_000;
    const { path, handle, events } = await fixture('');
    await handle.poll();
    appendFileSync(
      path,
      Array.from({ length: count }, (_, index) => assistantRow(index, { text: `Reply ${index}` })).join(''),
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
    expect(events.every(({ event, replay }) => event.type === 'conversation:assistant-message' && !replay)).toBe(true);
  });

  it('stops live assistant delivery when disposed during a yielded batch', async () => {
    const { path, handle, events } = await fixture('');
    await handle.poll();
    appendFileSync(
      path,
      Array.from({ length: 2_000 }, (_, index) => assistantRow(index, { text: `Reply ${index}` })).join(''),
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
    let release!: (snapshot: readonly ClaudeTranscriptRecord[]) => void;
    const updated = decodeClaudeTranscript(assistantRow(1, { text: 'New reply' }));
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(updated);
    vi.spyOn(jsonlReader, 'createClaudeTranscriptReader').mockReturnValue({ read });
    const { handle, events } = await fixture('');
    const first = handle.poll();
    await Promise.resolve();
    const hinted = Array.from({ length: 100 }, () => handle.poll({ hookEventName: 'Stop' }));
    release([]);
    await Promise.all([first, ...hinted]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'conversation:assistant-message', text: 'New reply' }),
    ]);
  });

  it('silently baselines transcript history including model, usage and workflow records', async () => {
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

    expect(events).toEqual([]);
    expect(await provider.capabilities()).toEqual([]);

    const count = events.length;
    await handle.poll();
    expect(events).toHaveLength(count);
    await handle.dispose();
  });

  it('reports transcript read failures and recovers on the next poll', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-transcript-isolation-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, 'transcript.jsonl');
    mkdirSync(transcriptPath);
    const provider = new ClaudeTranscriptObservationProvider();
    const handle = await provider.attach({ nativeSessionId: sessionId, transcriptPath, pollIntervalMs: 0 });
    handles.push(handle);
    const events: SemanticObservationEvent[] = [];
    const errors: Error[] = [];
    handle.onEvent((event) => events.push(event));
    handle.onError((error) => errors.push(error));

    await handle.poll();

    expect(errors).toHaveLength(1);
    expect(events).toEqual([]);
    rmSync(transcriptPath, { recursive: true });
    writeFileSync(transcriptPath, assistantRow(1, { text: 'Old reply' }));
    await handle.poll();
    expect(errors).toHaveLength(1);
    expect(events).toEqual([]);
    appendFileSync(transcriptPath, assistantRow(2, { text: 'New reply' }));
    await handle.poll();
    expect(errors).toHaveLength(1);
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ type: 'conversation:assistant-message', text: 'New reply' }),
    ]);
  });
});
