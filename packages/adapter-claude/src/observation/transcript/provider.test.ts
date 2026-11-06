import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SemanticObservationEvent, SemanticObservationHandle } from '../semantic-provider.js';
import { ClaudeTranscriptProjection, projectClaudeTranscriptAssistants } from './conversation.js';
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

  it('keys a reply to the turn it answers while a row after it still awaits its own parent', async () => {
    // Teardown flushes two rows before their parents: prompt-2 before reply-2, and reply-4 before reply-3. Nothing
    // leaves the window, so a parent that has not arrived cuts no row's ancestry: the walk keys every reply.
    const at = '2026-10-25T02:00:00.000Z';
    const line = (row: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'session-1', timestamp: at, ...row }) + '\n';
    const ask = (uuid: string, parentUuid: string | null, text: string) =>
      line({ type: 'user', uuid, parentUuid, turnOrigin: 'human', message: { role: 'user', content: text } });
    const answer = (uuid: string, parentUuid: string, text: string) =>
      line({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const { path, handle, events } = await fixture(
      ask('prompt-1', null, 'First question') + answer('reply-1', 'prompt-1', 'One.'),
    );
    const turnsOf = (id: string) =>
      events.filter(({ event }) => (event as { messageId?: string }).messageId === id).map(({ turnId }) => turnId);
    await handle.poll();
    expect(events).toEqual([]);

    appendFileSync(path, ask('prompt-2', 'reply-2', 'Second question'));
    await handle.poll();
    appendFileSync(path, answer('reply-4', 'reply-3', 'Four.'));
    await handle.poll();
    expect(turnsOf('reply-4')).toEqual(['prompt-2']);
    // reply-2 answers the first prompt: it is published there, though reply-4 was read in the second turn before it.
    appendFileSync(path, answer('reply-2', 'reply-1', 'Two.'));
    await handle.poll();
    expect(turnsOf('reply-2')).toEqual(['prompt-1']);

    // Once every parent has arrived each reply is in the turn it answers, and reply-2 is not announced again.
    appendFileSync(path, answer('reply-3', 'prompt-2', 'Three.'));
    await handle.poll();
    expect(turnsOf('reply-2')).toEqual(['prompt-1']);
    expect(turnsOf('reply-3')).toEqual(['prompt-2']);
    expect(turnsOf('reply-4').at(-1)).toBe('prompt-2');
  });

  it("re-announces nothing when the window evicts a turn's prompt: the turn's replies keep their turn", async () => {
    const real = jsonlReader.createClaudeTranscriptReader;
    vi.spyOn(jsonlReader, 'createClaudeTranscriptReader').mockImplementation((path) => real(path, { maxRecords: 9 }));
    const at = (second: number) => new Date(Date.parse('2026-10-25T02:00:00.000Z') + second * 1_000).toISOString();
    const rows: Record<string, unknown>[] = [];
    let parentUuid: string | null = null;
    const node = (row: Record<string, unknown>) => {
      rows.push({ ...row, parentUuid, sessionId: 'session-1', timestamp: at(rows.length) });
      parentUuid = row.uuid as string;
    };
    const ask = (uuid: string, text: string) =>
      node({ type: 'user', uuid, turnOrigin: 'human', message: { role: 'user', content: text } });
    const answer = (uuid: string, text: string) =>
      node({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    // Three turns of a prompt and two replies: exactly the nine rows the window holds.
    for (const turn of [0, 1, 2]) {
      ask(`prompt-${turn}`, `Question ${turn}`);
      answer(`reply-${turn}-1`, `Answer ${turn}.1`);
      answer(`reply-${turn}-2`, `Answer ${turn}.2`);
    }
    const { path, handle, events } = await fixture(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await handle.poll();
    expect(events).toEqual([]);

    // One more reply to the last turn evicts the first turn's prompt.
    answer('reply-2-3', 'Answer 2.3');
    appendFileSync(path, JSON.stringify(rows.at(-1)) + '\n');
    await handle.poll();
    expect(events.map(({ turnId, event, replay }) => ({ turnId, event, replay }))).toEqual([
      {
        turnId: 'prompt-2',
        event: {
          type: 'conversation:assistant-message',
          messageId: 'reply-2-3',
          turnId: 'prompt-2',
          text: 'Answer 2.3',
          final: true,
          displayOnly: false,
        },
        replay: undefined,
      },
    ]);
  });

  describe('the projection extends its walk by the rows a read appends', () => {
    const at = '2026-10-25T02:00:00.000Z';
    const line = (row: Record<string, unknown>) =>
      JSON.stringify({ sessionId: 'session-1', timestamp: at, ...row }) + '\n';
    const ask = (uuid: string, parentUuid: string | null, text: string) =>
      line({ type: 'user', uuid, parentUuid, turnOrigin: 'human', message: { role: 'user', content: text } });
    const answer = (uuid: string, parentUuid: string, text: string) =>
      line({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const replies = (events: readonly SemanticObservationEvent[]) =>
      events.map(({ event, turnId }) => ({ messageId: (event as { messageId?: string }).messageId, turnId }));

    it('walks the window once, at the first read: appends extend it and an eviction re-projects nothing', async () => {
      const reproject = vi.spyOn(ClaudeTranscriptProjection.prototype, 'reproject');
      const real = jsonlReader.createClaudeTranscriptReader;
      vi.spyOn(jsonlReader, 'createClaudeTranscriptReader').mockImplementation((path) => real(path, { maxRecords: 4 }));
      const { path, handle, events } = await fixture(
        ask('prompt-1', null, 'First question') +
          answer('reply-1', 'prompt-1', 'One.') +
          answer('reply-2', 'reply-1', 'Two.'),
      );
      await handle.poll();
      expect(reproject).toHaveBeenCalledTimes(1);

      appendFileSync(path, answer('reply-3', 'reply-2', 'Three.'));
      await handle.poll();
      // The window holds four rows, so this append evicts the first prompt and its first reply.
      appendFileSync(path, ask('prompt-2', 'reply-3', 'Second question') + answer('reply-4', 'prompt-2', 'Four.'));
      await handle.poll();

      expect(replies(events)).toEqual([
        { messageId: 'reply-3', turnId: 'prompt-1' },
        { messageId: 'reply-4', turnId: 'prompt-2' },
      ]);
      expect(reproject).toHaveBeenCalledTimes(1);
    });

    it('walks the window again when a parent is flushed one read after its child, and re-keys the child', async () => {
      const reproject = vi.spyOn(ClaudeTranscriptProjection.prototype, 'reproject');
      const { path, handle, events } = await fixture(
        ask('prompt-1', null, 'First question') + answer('reply-1', 'prompt-1', 'One.'),
      );
      await handle.poll();

      // Teardown flushes the second turn's reply before its prompt.
      appendFileSync(path, answer('reply-2', 'prompt-2', 'Two.'));
      await handle.poll();
      expect(reproject).toHaveBeenCalledTimes(1);
      appendFileSync(path, ask('prompt-2', 'reply-1', 'Second question'));
      await handle.poll();

      expect(reproject).toHaveBeenCalledTimes(2);
      expect(replies(events)).toEqual([
        { messageId: 'reply-2', turnId: 'prompt-1' },
        { messageId: 'reply-2', turnId: 'prompt-2' },
      ]);
    });

    describe("each reply the window holds is published in the unbounded walk's turn, whichever rows it holds", () => {
      /** Every attach reads through a reader that holds `maxRecords` rows. */
      const holding = (maxRecords: number) => {
        const real = jsonlReader.createClaudeTranscriptReader;
        vi.spyOn(jsonlReader, 'createClaudeTranscriptReader').mockImplementation((path) => real(path, { maxRecords }));
      };
      /** Attaches through a reader that holds `maxRecords` rows, then appends `rows` one per read. */
      const oneByOne = async (maxRecords: number, initial: string, rows: readonly string[]) => {
        holding(maxRecords);
        const { path, handle, events } = await fixture(initial);
        await handle.poll();
        expect(events).toEqual([]);
        for (const row of rows) {
          appendFileSync(path, row);
          await handle.poll();
        }
        return replies(events);
      };

      it('walks the window again after it evicts a late pair, and re-keys no reply it holds', async () => {
        // Teardown flushes prompt-3 before its parent reply-2, and reply-6 before its parent reply-5. When reply-5
        // arrives the window (five rows) has evicted prompt-1, reply-1 and prompt-3: reply-2 still answers prompt-1,
        // and reply-4 and reply-6 still descend from reply-3, which answers prompt-3.
        const initial = ask('prompt-1', null, 'First question') + answer('reply-1', 'prompt-1', 'One.');
        const published = await oneByOne(5, initial, [
          ask('prompt-3', 'reply-2', 'Third question'),
          answer('reply-3', 'prompt-3', 'Three.'),
          answer('reply-2', 'reply-1', 'Two.'),
          answer('reply-4', 'reply-3', 'Four.'),
          answer('reply-6', 'reply-5', 'Six.'),
          answer('reply-5', 'reply-4', 'Five.'),
        ]);
        expect(published).toEqual([
          { messageId: 'reply-3', turnId: 'prompt-3' },
          { messageId: 'reply-2', turnId: 'prompt-1' },
          { messageId: 'reply-4', turnId: 'prompt-3' },
          { messageId: 'reply-6', turnId: 'prompt-3' },
          { messageId: 'reply-5', turnId: 'prompt-3' },
        ]);
      });

      it('keeps a long turn across a compaction once its prompt has left the window (I1a)', async () => {
        // An auto-compaction mid-turn writes a root boundary. reply-3's arrival walks the window whole, and the window
        // (five rows) holds no prompt by then: every reply below the boundary still answers prompt-1.
        const initial = ask('prompt-1', null, 'First question') + answer('reply-1', 'prompt-1', 'One.');
        const published = await oneByOne(5, initial, [
          line({
            type: 'system',
            subtype: 'compact_boundary',
            uuid: 'boundary',
            parentUuid: null,
            logicalParentUuid: 'reply-1',
          }),
          line({ type: 'user', uuid: 'summary', parentUuid: 'boundary', isCompactSummary: true }),
          answer('reply-2', 'summary', 'Two.'),
          answer('reply-4', 'reply-3', 'Four.'),
          answer('reply-3', 'reply-2', 'Three.'),
        ]);
        expect(published).toEqual([
          { messageId: 'reply-2', turnId: 'prompt-1' },
          { messageId: 'reply-4', turnId: 'prompt-1' },
          { messageId: 'reply-3', turnId: 'prompt-1' },
        ]);
      });

      it('keys replies flushed before their parents to the turn they answer after its prompt left (I1b)', async () => {
        // reply-3's and reply-5's arrivals each walk a window (four rows) that holds no prompt.
        const published = await oneByOne(4, ask('prompt-1', null, 'First question'), [
          answer('reply-1', 'prompt-1', 'One.'),
          answer('reply-2', 'reply-1', 'Two.'),
          answer('reply-4', 'reply-3', 'Four.'),
          answer('reply-3', 'reply-2', 'Three.'),
          answer('reply-6', 'reply-5', 'Six.'),
          answer('reply-5', 'reply-4', 'Five.'),
        ]);
        expect(published).toEqual([
          { messageId: 'reply-1', turnId: 'prompt-1' },
          { messageId: 'reply-2', turnId: 'prompt-1' },
          { messageId: 'reply-4', turnId: 'prompt-1' },
          { messageId: 'reply-3', turnId: 'prompt-1' },
          { messageId: 'reply-6', turnId: 'prompt-1' },
          { messageId: 'reply-5', turnId: 'prompt-1' },
        ]);
      });

      it('keys a reply written again as its first row was, in the read that evicts the first row (I3)', async () => {
        // reply-1 is written again after prompt-2, in the read whose eviction takes its first row (three rows held):
        // the key is published again, still under prompt-1, and reply-2 is not.
        const published = await oneByOne(3, ask('prompt-1', null, 'First question'), [
          answer('reply-1', 'prompt-1', 'One.'),
          answer('reply-2', 'reply-1', 'Two.'),
          ask('prompt-2', 'reply-2', 'Second question'),
          answer('reply-1', 'prompt-1', 'One.'),
        ]);
        expect(published).toEqual([
          { messageId: 'reply-1', turnId: 'prompt-1' },
          { messageId: 'reply-2', turnId: 'prompt-1' },
          { messageId: 'reply-1', turnId: 'prompt-1' },
        ]);
      });

      it('starts a walk in the last prompt the unbounded walk passed, not the last one evicted (D1a)', async () => {
        // Teardown flushes prompt-3 before its parent reply-2, so the walk passes prompt-2 first. prompt-3 leaves the
        // window (five rows) at reply-6's read and prompt-2 at reply-5's: reply-8 still answers prompt-3.
        const initial = ask('prompt-1', null, 'First question') + answer('reply-1', 'prompt-1', 'One.');
        const published = await oneByOne(5, initial, [
          ask('prompt-3', 'reply-2', 'Third question'),
          ask('prompt-2', 'reply-1', 'Second question'),
          answer('reply-2', 'prompt-2', 'Two.'),
          answer('reply-4', 'reply-3', 'Four.'),
          answer('reply-3', 'prompt-3', 'Three.'),
          answer('reply-6', 'reply-5', 'Six.'),
          answer('reply-5', 'reply-4', 'Five.'),
          answer('reply-8', 'reply-7', 'Eight.'),
        ]);
        expect(published).toEqual([
          { messageId: 'reply-2', turnId: 'prompt-2' },
          { messageId: 'reply-4', turnId: 'prompt-3' },
          { messageId: 'reply-3', turnId: 'prompt-3' },
          { messageId: 'reply-6', turnId: 'prompt-3' },
          { messageId: 'reply-5', turnId: 'prompt-3' },
          { messageId: 'reply-8', turnId: 'prompt-3' },
        ]);
      });

      it('passes a departed prompt after the held row it waited on, as the unbounded walk does (D1b)', async () => {
        // prompt-3 waited on reply-2, so the unbounded walk passes it after reply-2. At reply-4's read prompt-3 has
        // left the window (five rows) while reply-2 and prompt-2 are held: reply-4 and reply-7 still answer prompt-3.
        const initial = ask('prompt-1', null, 'First question') + answer('reply-1', 'prompt-1', 'One.');
        const published = await oneByOne(5, initial, [
          ask('prompt-3', 'reply-2', 'Third question'),
          ask('prompt-2', 'reply-1', 'Second question'),
          answer('reply-2', 'prompt-2', 'Two.'),
          answer('reply-3', 'prompt-3', 'Three.'),
          answer('reply-5', 'reply-4', 'Five.'),
          answer('reply-4', 'reply-3', 'Four.'),
          answer('reply-7', 'reply-6', 'Seven.'),
        ]);
        expect(published).toEqual([
          { messageId: 'reply-2', turnId: 'prompt-2' },
          { messageId: 'reply-3', turnId: 'prompt-3' },
          { messageId: 'reply-5', turnId: 'prompt-3' },
          { messageId: 'reply-4', turnId: 'prompt-3' },
          { messageId: 'reply-7', turnId: 'prompt-3' },
        ]);
      });

      it('opens no turn again for a prompt written again, and its first row keeps its children (D4)', async () => {
        // prompt-2 is written again after prompt-3: it re-opens nothing, so every later reply answers prompt-3, and
        // once the first prompt-2 leaves the window (five rows) reply-2 and prompt-3 still hang from it.
        const published = await oneByOne(5, ask('prompt-1', null, 'First question'), [
          answer('reply-1', 'prompt-1', 'One.'),
          ask('prompt-2', 'reply-1', 'Second question'),
          answer('reply-2', 'prompt-2', 'Two.'),
          ask('prompt-3', 'reply-2', 'Third question'),
          ask('prompt-2', 'reply-1', 'Second question'),
          answer('reply-4', 'reply-3', 'Four.'),
          answer('reply-3', 'prompt-3', 'Three.'),
          answer('reply-6', 'reply-5', 'Six.'),
        ]);
        expect(published).toEqual([
          { messageId: 'reply-1', turnId: 'prompt-1' },
          { messageId: 'reply-2', turnId: 'prompt-2' },
          { messageId: 'reply-4', turnId: 'prompt-3' },
          { messageId: 'reply-3', turnId: 'prompt-3' },
          { messageId: 'reply-6', turnId: 'prompt-3' },
        ]);
      });

      it('publishes what the unbounded walk says, read by read, over a seeded history of 200 reads', async () => {
        holding(16);
        // mulberry32 from a fixed seed: the same history on every run.
        let seed = 0x5eed2026;
        const random = () => {
          seed = (seed + 0x6d2b79f5) | 0;
          let mixed = Math.imul(seed ^ (seed >>> 15), seed | 1);
          mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)) ^ mixed;
          return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
        };
        const says = (role: 'user' | 'assistant', text: string) => ({ role, content: [{ type: 'text', text }] });
        const row = (fields: Record<string, unknown>) => ({ sessionId: 'session-1', timestamp: at, ...fields });
        let serial = 0;
        let tail: string | null = null;
        let side: string | null = null;
        let foreign: string | null = null;
        /** The next rows in causal order: one row, or a compaction's boundary and its summary. */
        const grow = (): Record<string, unknown>[] => {
          serial += 1;
          const uuid = `row-${serial}`;
          const roll = random();
          if (roll < 0.06) {
            // An auto-compaction mid-turn: a root boundary, then its summary, which continues the turn.
            tail = `${uuid}-summary`;
            return [
              row({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null }),
              row({ type: 'user', uuid: tail, parentUuid: uuid, isCompactSummary: true }),
            ];
          }
          if (roll < 0.14) {
            // A subagent's sidechain row: never a reply and never a prompt.
            const sidechain = { type: 'assistant', uuid, parentUuid: side ?? tail, isSidechain: true };
            side = uuid;
            return [row({ ...sidechain, message: says('assistant', 'Side.') })];
          }
          if (roll < 0.22) {
            // Another session's row in the same file: it fills the window and is never this session's.
            const other = { type: 'assistant', uuid, parentUuid: foreign, message: says('assistant', 'Elsewhere.') };
            foreign = uuid;
            return [row({ ...other, sessionId: 'session-2' })];
          }
          const main = (fields: Record<string, unknown>) => {
            const linked = row({ ...fields, uuid, parentUuid: tail });
            tail = uuid;
            return [linked];
          };
          if (roll < 0.3) return main({ type: 'user', turnOrigin: 'human', message: says('user', `Ask ${serial}`) });
          if (roll < 0.36) return main({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } });
          if (roll < 0.42) return main({ type: 'attachment' });
          return main({ type: 'assistant', message: says('assistant', `Answer ${serial}`) });
        };
        const stream: Record<string, unknown>[] = [];
        /**
         * Writes a block of one to three causal steps newest first, as teardown flushes (a compaction is two rows, so a
         * block holds at most four and a parent lands at most three rows after its child); then, now and then, one of
         * the last three rows written again, its reply text sometimes changed.
         */
        const write = () => {
          const size = random() < 0.3 ? 2 + Math.floor(random() * 2) : 1;
          const block: Record<string, unknown>[] = [];
          while (block.length < size) block.push(...grow());
          stream.push(...block.reverse());
          if (random() < 0.12) {
            const again = { ...stream[stream.length - 1 - Math.floor(random() * Math.min(3, stream.length))] };
            if (again.type === 'assistant' && random() < 0.5) again.message = says('assistant', 'Again.');
            stream.push(again);
          }
        };
        let appended = 0;
        const take = (count: number) => {
          while (stream.length < appended + count) write();
          appended += count;
          return stream.slice(appended - count, appended);
        };
        const encode = (rows: readonly Record<string, unknown>[]) =>
          rows.map((value) => `${JSON.stringify(value)}\n`).join('');
        type Said = { readonly turnId: string | undefined; readonly text: string };
        /** The unbounded walk over every row of this session the file holds, by message key. */
        const unbounded = () => {
          const said = new Map<string, Said>();
          const records = decodeClaudeTranscript(encode(stream.slice(0, appended)));
          const session = records.filter(({ sessionId }) => sessionId === 'session-1');
          for (const [key, { event, turnId }] of projectClaudeTranscriptAssistants(session)) {
            said.set(key, { turnId, text: (event as { text: string }).text });
          }
          return said;
        };
        /** The message key a written row carries, when it is one of this session's replies. */
        const keyOf = (value: Record<string, unknown>): string | undefined => {
          const reply = value.type === 'assistant' && value.isSidechain !== true && value.sessionId === 'session-1';
          return reply ? String(value.uuid) : undefined;
        };

        const { path, handle, events } = await fixture(encode(take(2)));
        await handle.poll();
        expect(events).toEqual([]);
        let before = unbounded();
        for (let read = 1; read <= 200; read += 1) {
          const kept = appended;
          appendFileSync(path, encode(take(1 + Math.floor(random() * 3))));
          const from = events.length;
          await handle.poll();
          const after = unbounded();
          // A key the window (sixteen rows) holds is published iff no row carrying it survives this read's evictions,
          // or its turn or text in the unbounded walk changed.
          const survivors = new Set(stream.slice(Math.max(0, appended - 16), kept).map(keyOf));
          const expected: Record<string, Said> = {};
          for (const key of new Set(stream.slice(Math.max(0, appended - 16), appended).map(keyOf))) {
            if (key === undefined) continue;
            const now = after.get(key)!;
            const was = before.get(key);
            const changed = was === undefined || was.turnId !== now.turnId || was.text !== now.text;
            if (!survivors.has(key) || changed) expected[key] = now;
          }
          const published: Record<string, Said> = {};
          for (const { event, turnId } of events.slice(from)) {
            const { messageId, text } = event as { messageId: string; text: string };
            published[messageId] = { turnId, text };
          }
          expect({ read, published }).toEqual({ read, published: expected });
          before = after;
        }

        // The history holds every class the row is for.
        const history = stream.slice(0, appended);
        const firstAt = new Map<unknown, number>();
        for (const [index, value] of history.entries()) if (!firstAt.has(value.uuid)) firstAt.set(value.uuid, index);
        expect({
          late: history.some((value, index) => (firstAt.get(value.parentUuid) ?? -1) > index),
          again: history.some((value, index) => firstAt.get(value.uuid) !== index),
          sidechain: history.some((value) => value.isSidechain === true),
          foreign: history.some((value) => value.sessionId === 'session-2'),
          compacted: history.some((value) => value.subtype === 'compact_boundary'),
          evicted: appended > 16,
        }).toEqual({ late: true, again: true, sidechain: true, foreign: true, compacted: true, evicted: true });
      });
    });
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
