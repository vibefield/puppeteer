import { describe, expect, it } from 'vitest';
import { claude2308TranscriptText } from '../../test-support/claude-transcript-fixtures.js';
import { projectClaudeTranscriptAssistants } from './conversation.js';
import { decodeClaudeTranscript } from './wire.js';

describe('Claude transcript assistant projection', () => {
  it('uses parent causality when teardown flushes an assistant before its prompt', () => {
    const records = decodeClaudeTranscript(
      [
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          parentUuid: 'prompt-context',
          timestamp: '2026-08-25T16:30:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Durable answer' }] },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'prompt-1',
          parentUuid: null,
          timestamp: '2026-08-25T16:30:00.000Z',
          message: { role: 'user', content: 'Original prompt' },
        }),
        JSON.stringify({
          type: 'attachment',
          uuid: 'prompt-context',
          parentUuid: 'prompt-1',
          timestamp: '2026-08-25T16:30:00.500Z',
        }),
      ].join('\n'),
    );

    expect([...projectClaudeTranscriptAssistants(records).values()].map(({ event }) => event)).toEqual([
      {
        type: 'conversation:assistant-message',
        messageId: 'assistant-1',
        turnId: 'prompt-1',
        text: 'Durable answer',
        final: true,
        displayOnly: false,
      },
    ]);
  });

  it('projects only conversation rows from a 2.1.308 transcript: no request bookkeeping becomes a message or a turn', () => {
    const records = decodeClaudeTranscript(
      claude2308TranscriptText([
        { promptUuid: 'prompt-1', prompt: 'List the files', answer: 'Two files.', tool: true },
        { promptUuid: 'prompt-2', prompt: 'Summarize them', answer: 'Both are notes.' },
        {
          promptUuid: 'prompt-3',
          prompt: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>',
          answer: 'The background agent finished.',
          turnOrigin: 'task_notification',
        },
      ]),
    );
    // The fixture really interleaves user- and assistant-role request blobs.
    expect(records.filter((record) => record.type === 'api-request-blob').map(({ message }) => message?.role)).toEqual([
      'user',
      'assistant',
      'user',
      'user',
      'user',
    ]);

    const projected = [...projectClaudeTranscriptAssistants(records).values()];
    expect(projected.map(({ event }) => event)).toEqual([
      {
        type: 'conversation:assistant-message',
        messageId: 'prompt-1-answer',
        turnId: 'prompt-1',
        text: 'Two files.',
        final: true,
        displayOnly: false,
      },
      {
        type: 'conversation:assistant-message',
        messageId: 'prompt-2-answer',
        turnId: 'prompt-2',
        text: 'Both are notes.',
        final: true,
        displayOnly: false,
      },
      // A system-injected prompt opens no turn of its own.
      {
        type: 'conversation:assistant-message',
        messageId: 'prompt-3-answer',
        turnId: 'prompt-2',
        text: 'The background agent finished.',
        final: true,
        displayOnly: false,
      },
    ]);
    expect(projected.some(({ timestamp }) => timestamp === new Date(0).toISOString())).toBe(false);
  });

  it('does not reconstruct historical prompts or synthesize turn outcomes', () => {
    const records = decodeClaudeTranscript(
      [
        JSON.stringify({
          type: 'user',
          uuid: 'prompt-1',
          timestamp: '2026-08-25T16:30:00.000Z',
          message: { role: 'user', content: 'First prompt' },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'prompt-2',
          timestamp: '2026-08-25T16:30:01.000Z',
          message: { role: 'user', content: 'Replacement prompt' },
        }),
      ].join('\n'),
    );

    expect([...projectClaudeTranscriptAssistants(records).values()]).toEqual([]);
  });
});
