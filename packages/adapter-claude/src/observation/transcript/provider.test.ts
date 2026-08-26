import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SemanticObservationEvent } from '../semantic-provider.js';
import { ClaudeTranscriptObservationProvider } from './provider.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ClaudeTranscriptObservationProvider', () => {
  it('replays root conversation, projects fallback usage, and reads exact workflow members', async () => {
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
    const handle = await provider.attach({ nativeSessionId: sessionId, transcriptPath, bootstrap: true });
    const events: SemanticObservationEvent[] = [];
    handle.onEvent((event) => events.push(event));
    await handle.poll();

    expect(events.filter(({ replay }) => replay).map(({ event }) => event.type)).toEqual([
      'turn.started',
      'assistant.message',
      'turn.completed',
      'tokens.used',
      'session.environment.updated',
      'workflow.updated',
    ]);
    expect(events.find(({ event }) => event.type === 'tokens.used')?.event).toMatchObject({
      usageId: 'claude-request:request-1',
      totalTokens: 48,
      meterTokens: 16,
    });
    expect(events.find(({ event }) => event.type === 'workflow.updated')?.event).toEqual({
      type: 'workflow.updated',
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

  it('includes exact-session child sidecars in fallback usage without replaying them as root conversation', async () => {
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
    const handle = await provider.attach({ nativeSessionId: sessionId, transcriptPath, bootstrap: true });
    const events: SemanticObservationEvent[] = [];
    handle.onEvent((event) => events.push(event));
    await handle.poll();

    expect(events.filter(({ event }) => event.type === 'assistant.message')).toHaveLength(0);
    expect(events.filter(({ event }) => event.type === 'tokens.used').map(({ event }) => event)).toEqual([
      expect.objectContaining({ usageId: 'claude-request:request-child', totalTokens: 30, meterTokens: 10 }),
    ]);
    expect(events.find(({ event }) => event.type === 'tokens.used')).toMatchObject({
      agentId: 'worker',
      agentType: 'researcher',
      replay: true,
    });
    expect(JSON.stringify(events)).not.toContain('request-foreign');
    await handle.dispose();
  });
});
