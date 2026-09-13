import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { decodeClaudeTranscript, type ClaudeTranscriptRecord } from '../wire.js';
import { createTranscriptYield } from './yield.js';

const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_RECORDS = 20_000;
const READ_CHUNK_BYTES = 256 * 1024;

export interface ClaudeTranscriptReader {
  /** The same immutable snapshot reference is returned until decoded records change. */
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
  let cachedSnapshot: readonly ClaudeTranscriptRecord[] | undefined;

  const retain = (record: ClaudeTranscriptRecord, wireBytes: number): void => {
    cachedSnapshot = undefined;
    records.push({ value: record, wireBytes });
    retainedBytes += wireBytes;
    while (records.length > maxRecords || retainedBytes > maxBytes) {
      const removed = records.shift();
      if (!removed) break;
      retainedBytes -= removed.wireBytes;
    }
  };

  const snapshot = (): readonly ClaudeTranscriptRecord[] => (cachedSnapshot ??= records.map(({ value }) => value));

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
    cachedSnapshot = undefined;
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
      if (!metadata.isFile()) {
        throw new Error(`Claude transcript path must be a regular file: ${path}`);
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
        const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, metadata.size - offset));
        const yieldIfNeeded = createTranscriptYield();
        // Capture this poll's end offset: continuous appends belong to the
        // next poll, and must not keep a bootstrap read running indefinitely.
        while (offset < metadata.size) {
          const length = Math.min(buffer.length, metadata.size - offset);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead === 0) break;
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
            const pause = yieldIfNeeded();
            if (pause) await pause;
          }
          nextLineIndex += completeLineCount;
          if (discardLeadingPartial || Buffer.byteLength(pending) > maxBytes) {
            // Do not keep rebuilding a discarded row across read chunks.
            pending = '';
            decoder = new StringDecoder('utf8');
            discardLeadingPartial = true;
          }
        }
        // A complete EOF row already present at attachment belongs to the
        // initial snapshot. Delaying it to the next poll would misclassify
        // an old assistant reply as a new live message.
        if (pending && !discardLeadingPartial) {
          const settled = await handle.stat();
          if (settled.size === metadata.size && settled.mtimeMs === metadata.mtimeMs) commitStableFinalRow();
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
