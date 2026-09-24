import { describe, expect, it } from 'vitest';
import { FrameDecoder, encodeFrame } from './framing.js';

const frame = (header: string, body: string): Buffer => Buffer.from(`${header}\r\n\r\n${body}`, 'utf8');

describe('Content-Length framing', () => {
  it('counts the body in bytes, not characters', () => {
    const encoded = encodeFrame({ text: 'héllo — 世界' });
    const body = JSON.stringify({ text: 'héllo — 世界' });
    expect(encoded.toString('utf8')).toBe(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
  });

  it('reassembles a frame delivered one byte at a time, multi-byte characters included', () => {
    const decoder = new FrameDecoder();
    const encoded = encodeFrame({ jsonrpc: '2.0', id: 1, result: { login: 'octo-dév 🎉' } });
    const messages: unknown[] = [];
    for (const byte of encoded) messages.push(...decoder.push(Buffer.from([byte])));
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: { login: 'octo-dév 🎉' } }]);
  });

  it('returns every frame one chunk completes and keeps the remainder', () => {
    const decoder = new FrameDecoder();
    const first = encodeFrame({ id: 1 });
    const second = encodeFrame({ id: 2 });
    const third = encodeFrame({ id: 3 });
    expect(decoder.push(Buffer.concat([first, second, third.subarray(0, 5)]))).toEqual([{ id: 1 }, { id: 2 }]);
    expect(decoder.push(third.subarray(5))).toEqual([{ id: 3 }]);
  });

  it('reads other headers and the header name in any case', () => {
    const body = '{"id":7}';
    const header = `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${body.length}`;
    expect(new FrameDecoder().push(frame(header, body))).toEqual([{ id: 7 }]);
  });

  it.each([
    ['a header block without Content-Length', frame('Content-Type: application/json', '{}')],
    ['a header line without a separator', frame('Content-Length 2', '{}')],
    ['a length that is not a number', frame('Content-Length: two', '{}')],
    ['a body that is not JSON', frame('Content-Length: 5', 'hello')],
    ['newline-delimited JSON', Buffer.from(`${'{"id":1}\n'.repeat(1_000)}`, 'utf8')],
    ['a body beyond the reader limit', frame(`Content-Length: ${2 * 1024 * 1024}`, '')],
  ])('refuses %s', (_label, bytes) => {
    expect(() => new FrameDecoder().push(bytes)).toThrow();
  });
});
