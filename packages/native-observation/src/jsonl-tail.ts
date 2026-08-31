import { open, stat } from 'node:fs/promises';

export interface JsonlTailRecord {
  value: unknown;
  cursorStart: number;
  cursorEnd: number;
  replay: boolean;
  sourceGeneration: number;
}

export interface JsonlTailDiagnostic {
  code: 'invalid-json' | 'oversized-record' | 'source-replaced' | 'source-truncated';
  message: string;
  cursorStart: number;
  cursorEnd: number;
  sourceGeneration: number;
}

export interface JsonlTailPoll {
  records: JsonlTailRecord[];
  diagnostics: JsonlTailDiagnostic[];
  cursor: number;
  sourceGeneration: number;
}

export interface AppendOnlyJsonlTailOptions {
  /** Existing byte boundary. Earlier records are bounded replay; later records are live. */
  replayBoundary?: number;
  maxReplayBytes?: number;
  readChunkBytes?: number;
  maxBytesPerPoll?: number;
  maxRecordBytes?: number;
}

export interface AppendOnlyJsonlTail {
  readonly path: string;
  cursor(): number;
  poll(): Promise<JsonlTailPoll>;
}

const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_BYTES_PER_POLL = 4 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_REPLAY_BYTES = 16 * 1024 * 1024;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return resolved;
}

export async function captureJsonlBoundary(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Tail one append-only JSONL file without treating partial writes as records.
 * The reader is byte based, so UTF-8 split across poll/read boundaries remains
 * intact and source cursors identify the exact native byte range.
 */
export function createAppendOnlyJsonlTail(path: string, options: AppendOnlyJsonlTailOptions = {}): AppendOnlyJsonlTail {
  const readChunkBytes = positiveInteger(options.readChunkBytes, DEFAULT_READ_CHUNK_BYTES, 'readChunkBytes');
  const maxBytesPerPoll = positiveInteger(options.maxBytesPerPoll, DEFAULT_MAX_BYTES_PER_POLL, 'maxBytesPerPoll');
  const maxRecordBytes = positiveInteger(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 'maxRecordBytes');
  const maxReplayBytes = positiveInteger(options.maxReplayBytes, DEFAULT_MAX_REPLAY_BYTES, 'maxReplayBytes');
  const replayBoundary = Math.max(0, Math.floor(options.replayBoundary ?? 0));
  let generationReplayBoundary = replayBoundary;
  let offset = Math.max(0, replayBoundary - maxReplayBytes);
  let pendingStart = offset;
  let pending = Buffer.alloc(0);
  let discarding = offset > 0;
  let generation = 0;
  let identity: string | undefined;
  let lastMtimeMs: number | undefined;

  const reset = (nextOffset: number, code: JsonlTailDiagnostic['code'], size: number): JsonlTailDiagnostic => {
    const previous = offset;
    generation += 1;
    generationReplayBoundary = 0;
    offset = nextOffset;
    pendingStart = nextOffset;
    pending = Buffer.alloc(0);
    discarding = nextOffset > 0;
    return {
      code,
      message: `${path} ${code === 'source-replaced' ? 'was replaced' : 'was truncated'}; restarting at byte ${nextOffset}`,
      cursorStart: Math.min(previous, size),
      cursorEnd: size,
      sourceGeneration: generation,
    };
  };

  return {
    path,
    cursor: () => offset,
    async poll(): Promise<JsonlTailPoll> {
      const diagnostics: JsonlTailDiagnostic[] = [];
      let metadata;
      try {
        metadata = await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { records: [], diagnostics, cursor: offset, sourceGeneration: generation };
        }
        throw error;
      }

      const nextIdentity = `${metadata.dev}:${metadata.ino}`;
      if (identity !== undefined && identity !== nextIdentity) {
        diagnostics.push(reset(0, 'source-replaced', metadata.size));
      } else if (
        metadata.size < offset ||
        (metadata.size === offset && lastMtimeMs !== undefined && metadata.mtimeMs !== lastMtimeMs)
      ) {
        diagnostics.push(reset(0, 'source-truncated', metadata.size));
      }
      identity = nextIdentity;
      lastMtimeMs = metadata.mtimeMs;

      const records: JsonlTailRecord[] = [];
      const available = Math.min(metadata.size - offset, maxBytesPerPoll);
      if (available <= 0) return { records, diagnostics, cursor: offset, sourceGeneration: generation };

      const handle = await open(path, 'r');
      try {
        let remaining = available;
        while (remaining > 0) {
          const requested = Math.min(readChunkBytes, remaining);
          const chunk = Buffer.allocUnsafe(requested);
          const chunkStart = offset;
          const { bytesRead } = await handle.read(chunk, 0, requested, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
          remaining -= bytesRead;
          let body = chunk.subarray(0, bytesRead);
          let bodyStart = chunkStart;

          if (discarding) {
            const newline = body.indexOf(0x0a);
            if (newline < 0) continue;
            body = body.subarray(newline + 1);
            bodyStart += newline + 1;
            pendingStart = bodyStart;
            discarding = false;
          }

          pending = pending.length === 0 ? Buffer.from(body) : Buffer.concat([pending, body]);
          while (true) {
            const newline = pending.indexOf(0x0a);
            if (newline < 0) break;
            const wireEnd = pendingStart + newline + 1;
            const line = pending.subarray(0, newline);
            pending = pending.subarray(newline + 1);
            const cursorStart = pendingStart;
            pendingStart = wireEnd;
            if (line.length === 0 || (line.length === 1 && line[0] === 0x0d)) continue;
            if (line.length > maxRecordBytes) {
              diagnostics.push({
                code: 'oversized-record',
                message: `${path} contains a JSONL record larger than ${maxRecordBytes} bytes`,
                cursorStart,
                cursorEnd: wireEnd,
                sourceGeneration: generation,
              });
              continue;
            }
            try {
              records.push({
                value: JSON.parse(line.toString('utf8')) as unknown,
                cursorStart,
                cursorEnd: wireEnd,
                replay: wireEnd <= generationReplayBoundary,
                sourceGeneration: generation,
              });
            } catch (error) {
              diagnostics.push({
                code: 'invalid-json',
                message: `${path} contains invalid JSON at bytes ${cursorStart}-${wireEnd}: ${error instanceof Error ? error.message : String(error)}`,
                cursorStart,
                cursorEnd: wireEnd,
                sourceGeneration: generation,
              });
            }
          }
          if (pending.length > maxRecordBytes) {
            diagnostics.push({
              code: 'oversized-record',
              message: `${path} contains an unterminated JSONL record larger than ${maxRecordBytes} bytes`,
              cursorStart: pendingStart,
              cursorEnd: offset,
              sourceGeneration: generation,
            });
            pending = Buffer.alloc(0);
            pendingStart = offset;
            discarding = true;
          }
        }
      } finally {
        await handle.close();
      }
      return { records, diagnostics, cursor: offset, sourceGeneration: generation };
    },
  };
}
