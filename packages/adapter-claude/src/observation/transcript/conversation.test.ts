import { describe, expect, it } from 'vitest';
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
