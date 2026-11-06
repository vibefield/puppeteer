import { describe, expect, it } from 'vitest';
import { createBoundedJsonBody, type BoundedJsonOptions, type BoundedJsonResult } from './bounded-json.js';

function read(chunks: readonly Uint8Array[], options: BoundedJsonOptions): BoundedJsonResult {
  const body = createBoundedJsonBody(options);
  for (const chunk of chunks) body.push(chunk);
  return body.end();
}

/** Every way of posting `bytes` as two chunks: the split at each byte offset, the empty halves included. */
function twoChunkSplits(bytes: Uint8Array): Uint8Array[][] {
  return Array.from({ length: bytes.length + 1 }, (_, at) => [bytes.subarray(0, at), bytes.subarray(at)]);
}

// Escapes (a backslash before a quote, and an escaped backslash before the closing quote), multi-byte UTF-8 raw and
// \u-escaped, every number form, empty and nested containers; then two strings long enough to elide at a 16-byte
// cap, and the top-level id last.
const TRICKY = String.raw`{"hook_event_name":"PostToolUse","esc":"a\"b\\\"c\\","tab":"\t\n\/\b\f\r","mb":"é😀ü","u":"é","pair":"😀","n":[-0.5e+3,0,12,1E-2,-0,7.25E3],"t":true,"f":false,"z":null,"empty":{},"none":[],"nested":{"k":"v","deep":[{"x":"y"},[1,[2]]]},"uni":"é é😀 ü ${'é'.repeat(20)}","long":"${'abcdefghij'.repeat(60)}","tool_use_id":"toolu_tricky"}`;

describe('createBoundedJsonBody', () => {
  it('keeps a body within the budget whole, exactly as JSON.parse reads it, however it is split', () => {
    const bytes = Buffer.from(TRICKY);
    const options = { retainBytes: bytes.length };
    const expected = { kind: 'whole', body: JSON.parse(TRICKY) };
    expect(read([bytes], options)).toEqual(expected);
    for (const chunks of twoChunkSplits(bytes)) expect(read(chunks, options)).toEqual(expected);
  });

  it('reduces a body past the budget to the same value at every split into two chunks', () => {
    const bytes = Buffer.from(TRICKY);
    const options = { retainBytes: 512, maxStringBytes: 16 };
    expect(bytes.length).toBeGreaterThan(options.retainBytes);
    const expected = {
      kind: 'reduced',
      body: { ...JSON.parse(TRICKY), uni: null, long: null },
      reduced: { receivedBytes: bytes.length, elided: 2, paths: ['uni', 'long'] },
    };
    expect(read([bytes], options)).toEqual(expected);
    for (const chunks of twoChunkSplits(bytes)) expect(read(chunks, options)).toEqual(expected);
  });

  it('one byte past the budget, a body that needs nothing elided reads as it would whole', () => {
    const bytes = Buffer.from(TRICKY);
    expect(read([bytes], { retainBytes: bytes.length - 1 })).toEqual({
      kind: 'reduced',
      body: JSON.parse(TRICKY),
      reduced: { receivedBytes: bytes.length, elided: 0, paths: [] },
    });
  });

  it('keeps the top-level ids that follow a 3.6 MB originalFile, and nulls the file', () => {
    const body = {
      session_id: '00000000-0000-4000-8000-00000000cafe',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/big.ts', old_string: 'a', new_string: 'b' },
      tool_response: { filePath: '/repo/big.ts', originalFile: 'x'.repeat(3_600_000), structuredPatch: [] },
      tool_use_id: 'toolu_big',
      duration_ms: 7,
    };
    const bytes = Buffer.from(JSON.stringify(body));
    // the socket's way: 64 KiB at a time
    const chunks = Array.from({ length: Math.ceil(bytes.length / 65_536) }, (_, n) =>
      bytes.subarray(n * 65_536, (n + 1) * 65_536),
    );
    expect(read(chunks, { retainBytes: 256 * 1024 })).toEqual({
      kind: 'reduced',
      body: { ...body, tool_response: { ...body.tool_response, originalFile: null } },
      reduced: { receivedBytes: bytes.length, elided: 1, paths: ['tool_response.originalFile'] },
    });
  });

  it('past the budget keeps only top-level scalars: deeper values drop, top-level containers read null', () => {
    const lines = Array.from({ length: 2_000 }, (_, n) => `+line ${n}`);
    const body = {
      hook_event_name: 'PostToolUse',
      tool_response: { structuredPatch: [{ lines }] },
      tool_input: { file_path: '/repo/a.ts' },
      tool_use_id: 'toolu_late',
      duration_ms: 3,
    };
    const result = read([Buffer.from(JSON.stringify(body))], { retainBytes: 1024, maxStringBytes: 64 });
    if (result.kind !== 'reduced') throw new Error(`expected a reduced body, read ${result.kind}`);
    const kept = (result.body.tool_response as { structuredPatch: Array<{ lines: string[] }> }).structuredPatch[0]!
      .lines;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(lines.length);
    expect(kept).toEqual(lines.slice(0, kept.length));
    expect(result.body).toEqual({
      hook_event_name: 'PostToolUse',
      tool_response: { structuredPatch: [{ lines: kept }] },
      tool_input: null,
      tool_use_id: 'toolu_late',
      duration_ms: 3,
    });
    expect(result.reduced.elided).toBe(lines.length - kept.length + 1);
    expect(result.reduced.paths).toHaveLength(16);
    expect(result.reduced.paths[0]).toBe(`tool_response.structuredPatch[0].lines[${kept.length}]`);
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThan(2 * 1024);
  });

  it('holds a reduced body to about twice the budget, however many top-level members follow', () => {
    const members = Object.fromEntries(Array.from({ length: 5_000 }, (_, n) => [`k${n}`, n]));
    const result = read([Buffer.from(JSON.stringify({ hook_event_name: 'Stop', ...members }))], { retainBytes: 256 });
    if (result.kind !== 'reduced') throw new Error(`expected a reduced body, read ${result.kind}`);
    expect(result.body.hook_event_name).toBe('Stop');
    const keptMembers = Object.keys(result.body).length - 1;
    expect(keptMembers).toBeGreaterThan(0);
    expect(keptMembers).toBeLessThan(5_000);
    expect(result.reduced.elided).toBe(5_000 - keptMembers);
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(2 * 256 + 16);
  });

  it('calls a top level that is not an object malformed, within the budget and past it', () => {
    for (const text of ['"a string"', '[1,2]', '42', 'null', '{nope', '']) {
      expect(read([Buffer.from(text)], { retainBytes: 1024 }).kind, text).toBe('malformed');
    }
    for (const text of [`[${'1,'.repeat(1_000)}1]`, `"${'x'.repeat(2_000)}"`]) {
      expect(read([Buffer.from(text)], { retainBytes: 1024 })).toEqual({ kind: 'malformed', message: 'not an object' });
    }
  });

  it('calls a body past the budget malformed when it is not JSON, even where it would have been elided', () => {
    const long = 'x'.repeat(2_000);
    for (const text of [
      `{"a":"${long}"`, // ends inside the object
      `{"a":"${long}"} trailing`,
      `{"a":"${long}\\q"}`, // a bad escape inside a string that is elided
      `{"a":"${long}\u0001"}`, // a raw control byte inside a string that is elided
      `{"a":"${long}","b":01}`,
      `{"a":[${'1,'.repeat(1_000)}]}`, // a trailing comma
      `{"a":"${long}"]`,
    ]) {
      expect(read([Buffer.from(text)], { retainBytes: 1024 }).kind, text.slice(-24)).toBe('malformed');
    }
  });
});
