import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ClaudeTranscriptRecord } from '../wire.js';
import { createClaudeTranscriptReader, type ClaudeTranscriptReader } from './jsonl-reader.js';

const MAX_DESCENDANT_FILES = 1_024;
const MAX_DESCENDANT_BYTES = 128 * 1024 * 1024;
const DESCENDANT_NAME = /^agent-[^/]+\.jsonl$/;

export interface ClaudeSessionTranscriptSnapshot {
  root: readonly ClaudeTranscriptRecord[];
  all: readonly ClaudeTranscriptRecord[];
}

export interface ClaudeSessionTranscriptReader {
  read(): Promise<ClaudeSessionTranscriptSnapshot>;
}

async function descendantPaths(transcriptPath: string, nativeSessionId: string): Promise<string[]> {
  if (
    !nativeSessionId ||
    basename(nativeSessionId) !== nativeSessionId ||
    nativeSessionId === '.' ||
    nativeSessionId === '..'
  ) {
    throw new RangeError('Claude native session id is not a safe directory name');
  }
  const projectDirectory = dirname(transcriptPath);
  const roots = [join(projectDirectory, 'subagents'), join(projectDirectory, nativeSessionId, 'subagents')];
  const paths = new Set<string>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      // Do not follow symlinks or recurse: only Claude's direct agent sidecars
      // are in scope; workflow subdirectories have a separate reader.
      if (entry.isFile() && DESCENDANT_NAME.test(entry.name)) paths.add(join(root, entry.name));
    }
  }
  const sorted = [...paths].sort();
  if (sorted.length > MAX_DESCENDANT_FILES) {
    throw new RangeError(`Claude session has more than ${MAX_DESCENDANT_FILES} descendant transcripts`);
  }
  return sorted;
}

/** Root conversation plus exact-session child sidecars, with bounded aggregate input. */
export function createClaudeSessionTranscriptReader(
  transcriptPath: string,
  nativeSessionId: string,
): ClaudeSessionTranscriptReader {
  const rootReader = createClaudeTranscriptReader(transcriptPath, { sourceId: 'root' });
  const descendantReaders = new Map<string, ClaudeTranscriptReader>();

  return {
    async read() {
      const discoveredPaths = await descendantPaths(transcriptPath, nativeSessionId);
      const paths: string[] = [];
      let descendantBytes = 0;
      for (const path of discoveredPaths) {
        try {
          const metadata = await lstat(path);
          if (!metadata.isFile()) continue;
          descendantBytes += metadata.size;
          paths.push(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (descendantBytes > MAX_DESCENDANT_BYTES) {
        throw new RangeError(`Claude descendant transcripts exceed the ${MAX_DESCENDANT_BYTES}-byte observation limit`);
      }

      const activePaths = new Set(paths);
      for (const path of descendantReaders.keys()) {
        if (!activePaths.has(path)) descendantReaders.delete(path);
      }

      const root = (await rootReader.read()).filter(
        (record) => !record.sessionId || record.sessionId === nativeSessionId,
      );
      const descendants: ClaudeTranscriptRecord[] = [];
      for (const path of paths) {
        let reader = descendantReaders.get(path);
        if (!reader) {
          reader = createClaudeTranscriptReader(path, {
            maxBytes: MAX_DESCENDANT_BYTES,
            sourceId: `descendant:${basename(path)}`,
          });
          descendantReaders.set(path, reader);
        }
        // A child sidecar must carry the exact session id. Unlike the selected
        // root file, a missing id is not enough to claim this session.
        descendants.push(...(await reader.read()).filter((record) => record.sessionId === nativeSessionId));
      }

      const all = [...root, ...descendants].sort(
        (left, right) =>
          Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
          left.sourceId.localeCompare(right.sourceId) ||
          left.index - right.index,
      );
      return { root, all };
    },
  };
}
