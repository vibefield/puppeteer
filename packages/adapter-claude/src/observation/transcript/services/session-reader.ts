import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { decodeClaudeTranscript, type ClaudeTranscriptRecord } from '../wire.js';
import { createClaudeTranscriptReader, type ClaudeTranscriptReader } from './jsonl-reader.js';

const MAX_DESCENDANT_FILES = 1_024;
const MAX_DESCENDANT_BYTES = 128 * 1024 * 1024;
const MAX_DESCENDANT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SHARED_PROBES = 256;
const SESSION_PROBE_BYTES = 256 * 1024;
const DESCENDANT_NAME = /^agent-[^/]+\.jsonl$/;

export interface ClaudeSessionTranscriptSnapshot {
  root: readonly ClaudeTranscriptRecord[];
  all: readonly ClaudeTranscriptRecord[];
}

export interface ClaudeSessionTranscriptReader {
  /** Stable by reference while the root and selected descendants are unchanged. */
  read(): Promise<ClaudeSessionTranscriptSnapshot>;
}

interface DescendantFile {
  path: string;
  exactDirectory: boolean;
  size: number;
  mtimeMs: number;
  device: number;
  inode: number;
}

interface SharedProbeState {
  size: number;
  mtimeMs: number;
  device: number;
  inode: number;
  matches: boolean;
}

async function listedFiles(root: string, exactDirectory: boolean): Promise<DescendantFile[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: DescendantFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !DESCENDANT_NAME.test(entry.name)) continue;
    const path = join(root, entry.name);
    try {
      const metadata = await lstat(path);
      if (metadata.isFile()) {
        files.push({
          path,
          exactDirectory,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          device: metadata.dev,
          inode: metadata.ino,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return files;
}

async function belongsToSession(file: DescendantFile, nativeSessionId: string): Promise<boolean> {
  if (file.exactDirectory) return true;
  const handle = await open(file.path, 'r');
  try {
    const half = Math.floor(SESSION_PROBE_BYTES / 2);
    const headLength = Math.min(file.size, half);
    const tailStart = Math.max(headLength, file.size - half);
    const tailLength = file.size - tailStart;
    const head = Buffer.allocUnsafe(headLength);
    const tail = Buffer.allocUnsafe(tailLength);
    const headRead = headLength > 0 ? (await handle.read(head, 0, headLength, 0)).bytesRead : 0;
    const tailRead = tailLength > 0 ? (await handle.read(tail, 0, tailLength, tailStart)).bytesRead : 0;
    const probe = `${head.subarray(0, headRead).toString('utf8')}\n${tail.subarray(0, tailRead).toString('utf8')}`;
    return decodeClaudeTranscript(probe, 0, `probe:${basename(file.path)}`).some(
      (record) => record.sessionId === nativeSessionId,
    );
  } finally {
    await handle.close();
  }
}

async function descendantFiles(
  transcriptPath: string,
  nativeSessionId: string,
  sharedProbes: Map<string, SharedProbeState>,
): Promise<DescendantFile[]> {
  if (
    !nativeSessionId ||
    basename(nativeSessionId) !== nativeSessionId ||
    nativeSessionId === '.' ||
    nativeSessionId === '..'
  ) {
    throw new RangeError('Claude native session id is not a safe directory name');
  }
  const projectDirectory = dirname(transcriptPath);
  const exactRoot = join(projectDirectory, nativeSessionId, 'subagents');
  const sharedRoot = join(projectDirectory, 'subagents');
  const [exact, shared] = await Promise.all([listedFiles(exactRoot, true), listedFiles(sharedRoot, false)]);
  const exactPaths = new Set(exact.map((file) => file.path));
  const sharedCandidates = shared
    .filter((file) => !exactPaths.has(file.path))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, MAX_SHARED_PROBES);
  const candidatePaths = new Set(sharedCandidates.map(({ path }) => path));
  for (const path of sharedProbes.keys()) {
    if (!candidatePaths.has(path)) sharedProbes.delete(path);
  }
  const matchingShared: DescendantFile[] = [];
  for (const file of sharedCandidates) {
    const previous = sharedProbes.get(file.path);
    const sameFile = previous?.device === file.device && previous.inode === file.inode;
    const unchanged = sameFile && previous.size === file.size && previous.mtimeMs === file.mtimeMs;
    const appendToMatch = sameFile && previous.matches && file.size >= previous.size;
    const matches = unchanged || appendToMatch ? previous.matches : await belongsToSession(file, nativeSessionId);
    sharedProbes.set(file.path, {
      size: file.size,
      mtimeMs: file.mtimeMs,
      device: file.device,
      inode: file.inode,
      matches,
    });
    if (matches) matchingShared.push(file);
  }
  return [...exact, ...matchingShared]
    .sort(
      (left, right) =>
        Number(right.exactDirectory) - Number(left.exactDirectory) ||
        right.mtimeMs - left.mtimeMs ||
        left.path.localeCompare(right.path),
    )
    .slice(0, MAX_DESCENDANT_FILES);
}

/** Root conversation plus an exact-session, bounded rolling view of child sidecars. */
export function createClaudeSessionTranscriptReader(
  transcriptPath: string,
  nativeSessionId: string,
): ClaudeSessionTranscriptReader {
  const rootReader = createClaudeTranscriptReader(transcriptPath, { sourceId: 'root' });
  const descendantReaders = new Map<string, { reader: ClaudeTranscriptReader; maxBytes: number }>();
  const sharedProbes = new Map<string, SharedProbeState>();
  let previousSources: readonly (readonly ClaudeTranscriptRecord[])[] = [];
  let previousSnapshot: ClaudeSessionTranscriptSnapshot | undefined;

  return {
    async read() {
      const discovered = await descendantFiles(transcriptPath, nativeSessionId, sharedProbes);
      const selected: Array<{ file: DescendantFile; maxBytes: number }> = [];
      let remainingBytes = MAX_DESCENDANT_BYTES;
      for (const file of discovered) {
        if (remainingBytes <= 0) break;
        const maxBytes = Math.min(MAX_DESCENDANT_FILE_BYTES, remainingBytes);
        selected.push({ file, maxBytes });
        remainingBytes -= Math.min(file.size, maxBytes);
      }

      const activePaths = new Set(selected.map(({ file }) => file.path));
      for (const path of descendantReaders.keys()) {
        if (!activePaths.has(path)) descendantReaders.delete(path);
      }

      const sources = [await rootReader.read()];
      for (const { file, maxBytes } of selected) {
        let state = descendantReaders.get(file.path);
        if (!state || state.maxBytes !== maxBytes) {
          state = {
            maxBytes,
            reader: createClaudeTranscriptReader(file.path, {
              maxBytes,
              sourceId: `descendant:${file.exactDirectory ? 'exact' : 'shared'}:${basename(file.path)}`,
            }),
          };
          descendantReaders.set(file.path, state);
        }
        sources.push(await state.reader.read());
      }

      if (
        previousSnapshot &&
        sources.length === previousSources.length &&
        sources.every((source, index) => source === previousSources[index])
      )
        return previousSnapshot;

      const belongs = (record: ClaudeTranscriptRecord): boolean =>
        !record.sessionId || record.sessionId === nativeSessionId;
      const root = sources[0]!.filter(belongs);
      const all = sources
        .flatMap((source) => source.filter(belongs))
        .map((record) => ({ record, at: Date.parse(record.timestamp) }))
        .sort(
          (left, right) =>
            left.at - right.at ||
            left.record.sourceId.localeCompare(right.record.sourceId) ||
            left.record.index - right.record.index,
        )
        .map(({ record }) => record);
      previousSources = sources;
      previousSnapshot = { root, all };
      return previousSnapshot;
    },
  };
}
