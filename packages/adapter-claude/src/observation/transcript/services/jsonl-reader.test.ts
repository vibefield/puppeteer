import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_2_1_308_BOOKKEEPING_TYPES,
  CLAUDE_2_1_308_SIDE_TYPES,
  claude2308TranscriptText,
} from '../../../test-support/claude-transcript-fixtures.js';
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

  it('drops 2.1.308 request bookkeeping before the bounded window: kept rows keep their physical line ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-jsonl-bookkeeping-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    const text = claude2308TranscriptText([
      { promptUuid: 'prompt-1', prompt: 'List the files', answer: 'Two files.', tool: true },
      { promptUuid: 'prompt-2', prompt: 'Summarize them', answer: 'Both are notes.' },
    ]);
    writeFileSync(path, text);
    const lines = text.trimEnd().split('\n');
    // Kept rows are the conversation messages and every node of the parent-linked graph.
    const reader = createClaudeTranscriptReader(path, { maxRecords: 13 });
    const kept = await reader.read();
    const types = new Set(kept.map(({ type }) => type));
    for (const type of [...CLAUDE_2_1_308_BOOKKEEPING_TYPES, ...CLAUDE_2_1_308_SIDE_TYPES]) {
      expect(types.has(type), type).toBe(false);
    }
    expect([...types].sort()).toEqual(['assistant', 'attachment', 'system', 'user']);
    // The window holds the whole conversation: bookkeeping no longer counts against maxRecords.
    expect(kept).toHaveLength(13);
    expect(kept[0]?.uuid).toBe('prompt-1');
    expect(lines.length).toBeGreaterThan(30);
    for (const record of kept) expect(JSON.parse(lines[record.index]!).uuid).toBe(record.uuid);

    // A bookkeeping-only append changes nothing a projection reads, so the snapshot is reused.
    appendFileSync(path, `${JSON.stringify({ type: 'cost-state', modelUsage: {}, totalCostUSD: 0 })}\n`);
    appendFileSync(path, `${JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: 'x' } })}\n`);
    expect(await reader.read()).toBe(kept);
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
