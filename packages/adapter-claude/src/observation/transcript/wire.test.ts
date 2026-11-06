import { describe, expect, it } from 'vitest';
import { decodeClaudeTranscript } from './wire.js';

const userRows = (rows: readonly Record<string, unknown>[]) =>
  decodeClaudeTranscript(
    rows
      .map((row) =>
        JSON.stringify({
          type: 'user',
          timestamp: '2026-10-25T02:00:00.000Z',
          message: { role: 'user', content: 'prompt' },
          ...row,
        }),
      )
      .join('\n'),
  );

describe('Claude transcript wire decoding', () => {
  it("keeps a 2.1.308 user row's native turnOrigin and ignores absent or malformed values", () => {
    const [typed, sdk, notified, older, malformed] = userRows([
      { uuid: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 0, turnIndex: 1 } },
      { uuid: 'sdk', turnOrigin: 'sdk', promptSource: 'sdk', turnPosition: { promptIndex: 0, turnIndex: 1 } },
      { uuid: 'notified', turnOrigin: 'task_notification', turnPosition: { promptIndex: 0, turnIndex: 1 } },
      { uuid: 'older' },
      { uuid: 'malformed', turnOrigin: 7 },
    ]);

    expect(typed?.turnOrigin).toBe('human');
    expect(sdk?.turnOrigin).toBe('sdk');
    expect(notified?.turnOrigin).toBe('task_notification');
    expect(older).not.toHaveProperty('turnOrigin');
    expect(malformed).not.toHaveProperty('turnOrigin');
  });

  it('keeps the native isCompactSummary marker only when it is literally true', () => {
    const [summary, ordinary, absent, malformed] = userRows([
      { uuid: 'summary', isCompactSummary: true, isVisibleInTranscriptOnly: true },
      { uuid: 'ordinary', isCompactSummary: false },
      { uuid: 'absent' },
      { uuid: 'malformed', isCompactSummary: 'true' },
    ]);

    expect(summary?.isCompactSummary).toBe(true);
    expect(ordinary).not.toHaveProperty('isCompactSummary');
    expect(absent).not.toHaveProperty('isCompactSummary');
    expect(malformed).not.toHaveProperty('isCompactSummary');
  });

  it('keeps only what the projections read: text, a tool_use whole, a tool_result its id, and counts what it keeps', () => {
    const body = 'b'.repeat(1024 * 1024);
    const input = { file_path: '/workspace/notes.md' };
    const [result, reply] = decodeClaudeTranscript(
      [
        {
          type: 'user',
          uuid: 'result',
          timestamp: '2026-10-25T02:00:00.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_read', content: body },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: body } },
            ],
          },
        },
        {
          type: 'assistant',
          uuid: 'reply',
          timestamp: '2026-10-25T02:00:01.000Z',
          message: {
            role: 'assistant',
            model: 'claude-sonnet-4-5-20250929',
            content: [
              { type: 'thinking', thinking: body, signature: 'signature' },
              { type: 'redacted_thinking', data: body },
              { type: 'text', text: 'Reading it.' },
              { type: 'tool_use', id: 'toolu_read', name: 'Read', input },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );

    expect(result?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_read' }]);
    expect(reply?.content).toEqual([
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'toolu_read', name: 'Read', input },
    ]);
    expect(result).not.toHaveProperty('message');
    expect(reply).not.toHaveProperty('message');
    // The megabyte bodies are neither kept nor counted; the text and the tool input are.
    expect(result?.keptBytes).toBeLessThan(4_096);
    expect(reply?.keptBytes).toBeGreaterThanOrEqual('Reading it.'.length + JSON.stringify(input).length);
    expect(reply?.keptBytes).toBeLessThan(4_096);
  });

  it('reads string content as one text block, and a row without a message keeps none', () => {
    const [prompt, attachment] = decodeClaudeTranscript(
      [
        { type: 'user', uuid: 'prompt', message: { role: 'user', content: 'Refactor the parser' } },
        { type: 'attachment', uuid: 'attachment', attachment: { type: 'synthetic' } },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );

    expect(prompt?.content).toEqual([{ type: 'text', text: 'Refactor the parser' }]);
    expect(attachment).not.toHaveProperty('content');
    expect(attachment?.keptBytes).toBeGreaterThan(0);
  });
});
