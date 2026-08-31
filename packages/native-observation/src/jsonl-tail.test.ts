import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureJsonlBoundary, createAppendOnlyJsonlTail } from './jsonl-tail.js';

describe('append-only JSONL tail', () => {
  it('holds partial UTF-8 rows and reports exact cursors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-jsonl-'));
    const path = join(root, 'events.jsonl');
    const first = `${JSON.stringify({ text: 'π' })}\n`;
    const bytes = Buffer.from(first);
    writeFileSync(path, bytes.subarray(0, bytes.length - 2));
    const tail = createAppendOnlyJsonlTail(path);
    expect((await tail.poll()).records).toEqual([]);
    appendFileSync(path, bytes.subarray(bytes.length - 2));
    const result = await tail.poll();
    expect(result.records).toMatchObject([{ value: { text: 'π' }, cursorStart: 0, cursorEnd: bytes.length }]);
  });

  it('bounds replay and marks only records before the captured boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-jsonl-replay-'));
    const path = join(root, 'events.jsonl');
    writeFileSync(path, '{"n":1}\n{"n":2}\n');
    const boundary = await captureJsonlBoundary(path);
    appendFileSync(path, '{"n":3}\n');
    const result = await createAppendOnlyJsonlTail(path, { replayBoundary: boundary }).poll();
    expect(result.records.map(({ value, replay }) => ({ value, replay }))).toEqual([
      { value: { n: 1 }, replay: true },
      { value: { n: 2 }, replay: true },
      { value: { n: 3 }, replay: false },
    ]);
  });

  it('recovers when a writer replaces the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-jsonl-replace-'));
    const path = join(root, 'events.jsonl');
    const replacement = join(root, 'replacement.jsonl');
    writeFileSync(path, '{"n":1}\n');
    const tail = createAppendOnlyJsonlTail(path, { replayBoundary: await captureJsonlBoundary(path) });
    await tail.poll();
    writeFileSync(replacement, '{"n":2}\n');
    renameSync(replacement, path);
    const result = await tail.poll();
    expect(result.diagnostics[0]?.code).toBe('source-replaced');
    expect(result.records[0]).toMatchObject({ value: { n: 2 }, replay: false, sourceGeneration: 1 });
  });
});
