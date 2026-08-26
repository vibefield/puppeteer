import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { decodeClaudeTranscript, type ClaudeTranscriptRecord } from '../wire.js';

const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export interface ClaudeTranscriptReader {
  read(): Promise<readonly ClaudeTranscriptRecord[]>;
}

/** Append-aware reader: unchanged polls do no I/O and partial final rows remain pending. */
export function createClaudeTranscriptReader(
  path: string,
  options: { maxBytes?: number; sourceId?: string } = {},
): ClaudeTranscriptReader {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  let offset = 0;
  let lastMtimeMs: number | undefined;
  let pending = '';
  let nextLineIndex = 0;
  let decoder = new StringDecoder('utf8');
  const records: ClaudeTranscriptRecord[] = [];

  const reset = (): void => {
    offset = 0;
    pending = '';
    nextLineIndex = 0;
    decoder = new StringDecoder('utf8');
    records.length = 0;
  };

  return {
    async read() {
      let metadata;
      try {
        metadata = await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return records;
        throw error;
      }
      if (metadata.size > maxBytes) {
        throw new RangeError(`Claude transcript exceeds the ${maxBytes}-byte observation limit`);
      }
      if (
        metadata.size < offset ||
        (metadata.size === offset && lastMtimeMs !== undefined && metadata.mtimeMs !== lastMtimeMs)
      ) {
        reset();
      }
      lastMtimeMs = metadata.mtimeMs;
      if (metadata.size === offset) return records;

      const handle = await open(path, 'r');
      try {
        const length = metadata.size - offset;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        offset += bytesRead;
        const parts = (pending + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        pending = parts.pop() ?? '';
        if (parts.length > 0) {
          const complete = decodeClaudeTranscript(parts.join('\n'), nextLineIndex, options.sourceId);
          records.push(...complete);
          nextLineIndex += parts.length;
        }
      } finally {
        await handle.close();
      }
      return records;
    },
  };
}
