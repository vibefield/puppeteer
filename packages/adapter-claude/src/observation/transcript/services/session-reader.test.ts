import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeSessionTranscriptReader } from './session-reader.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function row(uuid: string, sessionId?: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-08-25T00:00:00.000Z',
    ...(sessionId ? { sessionId } : {}),
    message: { role: 'assistant', content: [{ type: 'text', text: uuid }] },
  })}\n`;
}

describe('createClaudeSessionTranscriptReader', () => {
  it('reuses unchanged snapshots and notices appended, added, and removed descendants', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-session-snapshots-'));
    roots.push(root);
    const path = join(root, 'session-1.jsonl');
    writeFileSync(path, row('root', 'session-1'));
    const reader = createClaudeSessionTranscriptReader(path, 'session-1');
    const first = await reader.read();
    expect(await reader.read()).toBe(first);
    const children = join(root, 'session-1', 'subagents');
    mkdirSync(children, { recursive: true });
    const child = join(children, 'agent-worker.jsonl');
    writeFileSync(child, row('child'));
    const second = await reader.read();
    expect(second).not.toBe(first);
    expect(second.all.map(({ uuid }) => uuid)).toContain('child');
    expect(await reader.read()).toBe(second);
    appendFileSync(child, row('child-append'));
    const third = await reader.read();
    expect(third.all.map(({ uuid }) => uuid)).toContain('child-append');
    expect(await reader.read()).toBe(third);
    rmSync(child);
    const fourth = await reader.read();
    expect(fourth.all.map(({ uuid }) => uuid)).toEqual(['root']);
    expect(await reader.read()).toBe(fourth);
    appendFileSync(path, row('root-append', 'session-1'));
    expect((await reader.read()).root.map(({ uuid }) => uuid)).toEqual(['root', 'root-append']);
  });

  it('accepts exact-directory rows without repeated session ids and keeps shared source identities distinct', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-session-reader-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, '');

    const exactDirectory = join(root, sessionId, 'subagents');
    const sharedDirectory = join(root, 'subagents');
    mkdirSync(exactDirectory, { recursive: true });
    mkdirSync(sharedDirectory, { recursive: true });
    writeFileSync(join(exactDirectory, 'agent-worker.jsonl'), row('exact-row'));
    writeFileSync(join(sharedDirectory, 'agent-worker.jsonl'), row('shared-row', sessionId));

    const snapshot = await createClaudeSessionTranscriptReader(transcriptPath, sessionId).read();
    const descendants = snapshot.all.filter(({ sourceId }) => sourceId.startsWith('descendant:'));

    expect(descendants.map(({ uuid }) => uuid).sort()).toEqual(['exact-row', 'shared-row']);
    expect(new Set(descendants.map(({ sourceId }) => sourceId)).size).toBe(2);
  });

  it('keeps a positively associated shared sidecar when later rows omit the session id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-shared-session-reader-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, '');
    const sharedDirectory = join(root, 'subagents');
    mkdirSync(sharedDirectory, { recursive: true });
    const sidecar = join(sharedDirectory, 'agent-worker.jsonl');
    writeFileSync(sidecar, row('identity-row', sessionId));
    const reader = createClaudeSessionTranscriptReader(transcriptPath, sessionId);

    await reader.read();
    appendFileSync(sidecar, row('later-row'));
    const snapshot = await reader.read();

    expect(snapshot.all.filter(({ sourceId }) => sourceId.startsWith('descendant:')).map(({ uuid }) => uuid)).toEqual([
      'identity-row',
      'later-row',
    ]);
  });

  it('probes both ends of a large legacy shared sidecar', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-shared-probe-reader-'));
    roots.push(root);
    const sessionId = 'session-1';
    const transcriptPath = join(root, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, '');
    const sharedDirectory = join(root, 'subagents');
    mkdirSync(sharedDirectory, { recursive: true });
    writeFileSync(
      join(sharedDirectory, 'agent-worker.jsonl'),
      `${row('identity-row', sessionId)}${'x'.repeat(SESSION_PROBE_FIXTURE_BYTES)}\n${row('tail-row')}`,
    );

    const snapshot = await createClaudeSessionTranscriptReader(transcriptPath, sessionId).read();

    expect(snapshot.all.filter(({ sourceId }) => sourceId.startsWith('descendant:')).map(({ uuid }) => uuid)).toEqual([
      'identity-row',
      'tail-row',
    ]);
  });
});

const SESSION_PROBE_FIXTURE_BYTES = 300 * 1024;
