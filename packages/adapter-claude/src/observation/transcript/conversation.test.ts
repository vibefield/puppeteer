import { describe, expect, it } from 'vitest';
import { projectClaudeTranscriptConversation } from './conversation.js';
import { decodeClaudeTranscript } from './wire.js';

describe('Claude transcript conversation projection', () => {
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

    expect(projectClaudeTranscriptConversation(records).history.map(({ event }) => event)).toEqual([
      { type: 'turn:started', turnId: 'prompt-1', prompt: 'Original prompt' },
      {
        type: 'conversation:assistant-message',
        messageId: 'assistant-1',
        turnId: 'prompt-1',
        text: 'Durable answer',
        final: true,
        displayOnly: false,
      },
      { type: 'turn:completed', turnId: 'prompt-1', lastAssistantMessage: 'Durable answer' },
    ]);
  });

  it('does not invent completion for a prompt with no assistant response', () => {
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

    expect(projectClaudeTranscriptConversation(records).history.map(({ event }) => event)).toEqual([
      { type: 'turn:started', turnId: 'prompt-1', prompt: 'First prompt' },
      {
        type: 'turn:failed',
        turnId: 'prompt-1',
        error: 'superseded by a newer user prompt before an assistant response',
      },
      { type: 'turn:started', turnId: 'prompt-2', prompt: 'Replacement prompt' },
      { type: 'turn:failed', turnId: 'prompt-2', error: 'interrupted before an assistant response' },
    ]);
  });
});
