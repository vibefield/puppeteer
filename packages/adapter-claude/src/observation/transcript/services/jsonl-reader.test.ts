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
  it('reuses unchanged snapshots and invalidates them for complete appends and truncation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-jsonl-snapshots-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, row('one'));
    const reader = createClaudeTranscriptReader(path);
    const first = await reader.read();
    expect(await reader.read()).toBe(first);
    appendFileSync(path, finalRow('two').slice(0, 40));
    expect(await reader.read()).toBe(first);
    appendFileSync(path, finalRow('two').slice(40) + '\n');
    const second = await reader.read();
    expect(second).not.toBe(first);
    expect(second.map(({ uuid }) => uuid)).toEqual(['one', 'two']);
    expect(first.map(({ uuid }) => uuid)).toEqual(['one']);
    expect(await reader.read()).toBe(second);
    writeFileSync(path, row('new'));
    const replaced = await reader.read();
    expect(replaced.map(({ uuid }) => uuid)).toEqual(['new']);
    expect(await reader.read()).toBe(replaced);
  });

  it('decodes multibyte text and line identities across bounded read chunks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-jsonl-chunks-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    const text = '🙂'.repeat(100_000);
    writeFileSync(
      path,
      JSON.stringify({ type: 'assistant', uuid: 'large', message: { content: text } }) + '\n' + row('tail'),
    );
    const result = await createClaudeTranscriptReader(path).read();
    expect(result.map(({ uuid, index }) => ({ uuid, index }))).toEqual([
      { uuid: 'large', index: 0 },
      { uuid: 'tail', index: 1 },
    ]);
    expect(result[0]?.message?.content).toBe(text);
  });

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

  it('includes a stable valid EOF row in the initial snapshot without a trailing newline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-jsonl-final-row-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, finalRow('final'));
    const reader = createClaudeTranscriptReader(path);

    const first = await reader.read();
    expect(first.map(({ uuid }) => uuid)).toEqual(['final']);
    expect(await reader.read()).toBe(first);
  });
});
