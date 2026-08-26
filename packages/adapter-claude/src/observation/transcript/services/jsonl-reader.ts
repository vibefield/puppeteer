import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { decodeClaudeTranscript, type ClaudeTranscriptRecord } from '../wire.js';

const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_RECORDS = 20_000;

export interface ClaudeTranscriptReader {
  read(): Promise<readonly ClaudeTranscriptRecord[]>;
}

interface RetainedRecord {
  value: ClaudeTranscriptRecord;
  wireBytes: number;
}

/** Append-aware reader: unchanged polls do no I/O and partial final rows remain pending. */
export function createClaudeTranscriptReader(
  path: string,
  options: { maxBytes?: number; maxRecords?: number; sourceId?: string } = {},
): ClaudeTranscriptReader {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_TRANSCRIPT_RECORDS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('transcript maxBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new RangeError('transcript maxRecords must be a positive safe integer');
  }
  let offset = 0;
  let lastMtimeMs: number | undefined;
  let pending = '';
  let nextLineIndex = 0;
  let decoder = new StringDecoder('utf8');
  let discardLeadingPartial = false;
  let retainedBytes = 0;
  const records: RetainedRecord[] = [];

  const retain = (record: ClaudeTranscriptRecord, wireBytes: number): void => {
    records.push({ value: record, wireBytes });
    retainedBytes += wireBytes;
    while (records.length > maxRecords || retainedBytes > maxBytes) {
      const removed = records.shift();
      if (!removed) break;
      retainedBytes -= removed.wireBytes;
    }
  };

  const snapshot = (): readonly ClaudeTranscriptRecord[] => records.map(({ value }) => value);

  const commitStableFinalRow = (): void => {
    if (!pending || discardLeadingPartial) return;
    const decoded = decodeClaudeTranscript(pending, nextLineIndex, options.sourceId);
    if (decoded.length !== 1) return;
    retain(decoded[0]!, Buffer.byteLength(pending));
    nextLineIndex += 1;
    pending = '';
    decoder = new StringDecoder('utf8');
  };

  const reset = (nextOffset = 0): void => {
    offset = nextOffset;
    pending = '';
    nextLineIndex = nextOffset;
    decoder = new StringDecoder('utf8');
    discardLeadingPartial = nextOffset > 0;
    records.length = 0;
    retainedBytes = 0;
  };

  return {
    async read() {
      let metadata;
      try {
        metadata = await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return snapshot();
        throw error;
      }
      if (
        metadata.size < offset ||
        (metadata.size === offset && lastMtimeMs !== undefined && metadata.mtimeMs !== lastMtimeMs)
      ) {
        reset(Math.max(0, metadata.size - maxBytes));
      }
      if (metadata.size - offset > maxBytes) reset(metadata.size - maxBytes);
      lastMtimeMs = metadata.mtimeMs;
      if (metadata.size === offset) {
        commitStableFinalRow();
        return snapshot();
      }

      const handle = await open(path, 'r');
      try {
        const length = metadata.size - offset;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        offset += bytesRead;
        const parts = (pending + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        pending = parts.pop() ?? '';
        const completeLineCount = parts.length;
        let firstLineIndex = nextLineIndex;
        if (discardLeadingPartial && parts.length > 0) {
          parts.shift();
          discardLeadingPartial = false;
          firstLineIndex += 1;
        }
        for (const [index, line] of parts.entries()) {
          const complete = decodeClaudeTranscript(line, firstLineIndex + index, options.sourceId);
          if (complete.length === 1) retain(complete[0]!, Buffer.byteLength(line) + 1);
        }
        nextLineIndex += completeLineCount;
        if (Buffer.byteLength(pending) > maxBytes) {
          // One malformed or giant unterminated row must not bypass the byte
          // retention cap. Ignore it through its next newline, then recover.
          pending = '';
          decoder = new StringDecoder('utf8');
          discardLeadingPartial = true;
        }
      } finally {
        await handle.close();
      }
      // Never expose the mutable retention buffer: callers may retain a poll
      // result while a later append is decoded.
      return snapshot();
    },
  };
}
