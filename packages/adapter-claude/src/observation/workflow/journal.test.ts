import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeWorkflowJournalObserver } from './journal.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createClaudeWorkflowJournalObserver', () => {
  it('increments journal state and bounds oversized history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-workflow-journal-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, '');
    const directory = join(root, sessionId, 'subagents', 'workflows', 'workflow-1');
    mkdirSync(directory, { recursive: true });
    const journal = join(directory, 'journal.jsonl');
    writeFileSync(journal, `${'x'.repeat(1_024)}\n${JSON.stringify({ type: 'started', agentId: 'worker-1' })}\n`);
    const observer = createClaudeWorkflowJournalObserver(transcriptPath, sessionId, { maxJournalBytes: 512 });

    expect((await observer.read())[0]?.event).toMatchObject({ active: true, members: [{ agentId: 'worker-1' }] });
    appendFileSync(journal, `${JSON.stringify({ type: 'result', agentId: 'worker-1' })}\n`);
    expect((await observer.read())[0]?.event).toMatchObject({ active: false, members: [{ state: 'completed' }] });
  });

  it('resets retained members when a journal is replaced at the same byte length', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-workflow-rewrite-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, '');
    const directory = join(root, sessionId, 'subagents', 'workflows', 'workflow-1');
    mkdirSync(directory, { recursive: true });
    const journal = join(directory, 'journal.jsonl');
    writeFileSync(journal, `${JSON.stringify({ type: 'started', agentId: 'worker-1' })}\n`);
    const observer = createClaudeWorkflowJournalObserver(transcriptPath, sessionId);

    expect((await observer.read())[0]?.event.members?.map(({ agentId }) => agentId)).toEqual(['worker-1']);
    writeFileSync(journal, `${JSON.stringify({ type: 'started', agentId: 'worker-2' })}\n`);
    const future = new Date(Date.now() + 2_000);
    utimesSync(journal, future, future);

    expect((await observer.read())[0]?.event.members?.map(({ agentId }) => agentId)).toEqual(['worker-2']);
  });

  it('commits a stable final journal row without requiring a trailing newline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-workflow-final-row-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, '');
    const directory = join(root, sessionId, 'subagents', 'workflows', 'workflow-1');
    mkdirSync(directory, { recursive: true });
    const journal = join(directory, 'journal.jsonl');
    writeFileSync(journal, JSON.stringify({ type: 'started', agentId: 'worker-1' }));
    const observer = createClaudeWorkflowJournalObserver(transcriptPath, sessionId);

    expect(await observer.read()).toEqual([]);
    expect((await observer.read())[0]?.event.members?.map(({ agentId }) => agentId)).toEqual(['worker-1']);
  });

  it('rejects invalid retention bounds', () => {
    expect(() => createClaudeWorkflowJournalObserver('/tmp/session.jsonl', 'session-1', { maxMembers: 0 })).toThrow(
      RangeError,
    );
  });
});
