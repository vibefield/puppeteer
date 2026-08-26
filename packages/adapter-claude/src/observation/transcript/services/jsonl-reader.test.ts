import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeTranscriptReader } from './jsonl-reader.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function row(uuid: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-08-25T00:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: uuid }] },
  })}\n`;
}

function finalRow(uuid: string): string {
  return row(uuid).slice(0, -1);
}

describe('createClaudeTranscriptReader', () => {
  it('tails an oversized append-only transcript instead of disabling observation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-jsonl-reader-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, `${'x'.repeat(1_024)}\n${row('recent-1')}${row('recent-2')}`);
    const reader = createClaudeTranscriptReader(path, { maxBytes: 512, maxRecords: 10 });

    const first = await reader.read();
    appendFileSync(path, row('recent-3'));
    const second = await reader.read();

    expect(first.map(({ uuid }) => uuid)).toEqual(['recent-1', 'recent-2']);
    expect(second.map(({ uuid }) => uuid)).toEqual(['recent-1', 'recent-2', 'recent-3']);
  });

  it('bounds retained decoded records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-jsonl-records-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, `${row('one')}${row('two')}${row('three')}`);
    const reader = createClaudeTranscriptReader(path, { maxBytes: 4_096, maxRecords: 2 });

    expect((await reader.read()).map(({ uuid }) => uuid)).toEqual(['two', 'three']);
  });

  it('bounds retained wire bytes across many small appends', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-jsonl-bytes-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, row('one'));
    const reader = createClaudeTranscriptReader(path, { maxBytes: 400, maxRecords: 100 });

    await reader.read();
    appendFileSync(path, row('two'));
    await reader.read();
    appendFileSync(path, row('three'));
    const retained = await reader.read();

    expect(retained.map(({ uuid }) => uuid)).not.toContain('one');
    expect(retained.map(({ uuid }) => uuid)).toContain('three');
  });

  it('drops one oversized unterminated row and resumes at the next newline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-jsonl-oversized-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, 'x'.repeat(300));
    const reader = createClaudeTranscriptReader(path, { maxBytes: 256, maxRecords: 10 });

    await reader.read();
    appendFileSync(path, 'x'.repeat(300));
    await reader.read();
    appendFileSync(path, `\n${row('recovered')}`);

    expect((await reader.read()).map(({ uuid }) => uuid)).toEqual(['recovered']);
  });

  it('commits a stable valid final row even when the file has no trailing newline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-jsonl-final-row-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, finalRow('final'));
    const reader = createClaudeTranscriptReader(path);

    expect(await reader.read()).toEqual([]);
    expect((await reader.read()).map(({ uuid }) => uuid)).toEqual(['final']);
  });
});
