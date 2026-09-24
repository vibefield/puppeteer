/**
 * LSP-style Content-Length framing for the Copilot CLI's JSON-RPC server
 * (`copilot --server --stdio`), the framing the official SDK speaks through
 * vscode-jsonrpc: `Name: value` header lines, a blank line, then exactly
 * Content-Length bytes of UTF-8 JSON. It is not newline-delimited JSON.
 *
 * Lengths count bytes, not characters, so frames are cut from Buffers and a
 * body is decoded only once all of it has arrived.
 */

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'ascii');
const MAX_HEADER_BYTES = 8 * 1024;
/** Far above any status document; a frame larger than this is not an answer this reader asked for. */
const MAX_BODY_BYTES = 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function contentLength(header: string): number {
  let length: number | undefined;
  for (const line of header.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('malformed Content-Length frame header');
    if (line.slice(0, separator).trim().toLowerCase() !== 'content-length') continue;
    const value = line.slice(separator + 1).trim();
    if (!/^\d+$/u.test(value)) throw new Error('malformed Content-Length value');
    length = Number(value);
  }
  if (length === undefined) throw new Error('frame header has no Content-Length');
  if (length > MAX_BODY_BYTES) throw new Error('frame body exceeds the reader limit');
  return length;
}

/**
 * Incremental decoder. `push` returns every message the bytes complete and
 * throws once the stream stops being Content-Length framed JSON; a stream
 * that has lost its framing cannot be resynchronized, so the caller ends it.
 */
export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      const end = this.buffered.indexOf(HEADER_TERMINATOR);
      if (end < 0 ? this.buffered.length > MAX_HEADER_BYTES : end > MAX_HEADER_BYTES) {
        throw new Error('frame header exceeds the reader limit');
      }
      if (end < 0) return messages;
      const length = contentLength(this.buffered.subarray(0, end).toString('ascii'));
      const start = end + HEADER_TERMINATOR.length;
      if (this.buffered.length < start + length) return messages;
      const body = this.buffered.subarray(start, start + length).toString('utf8');
      this.buffered = this.buffered.subarray(start + length);
      messages.push(JSON.parse(body));
    }
  }
}
