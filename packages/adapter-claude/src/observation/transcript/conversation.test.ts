import { describe, expect, it } from 'vitest';
import { projectClaudeTranscriptConversation } from './conversation.js';
import { decodeClaudeTranscript } from './wire.js';

describe('Claude transcript conversation projection', () => {
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
