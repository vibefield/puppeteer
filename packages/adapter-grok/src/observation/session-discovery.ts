import { existsSync, readdirSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** The Grok home a process running under `environment` reads: its GROK_HOME, else `~/.grok`. */
export function grokHomeIn(environment: NodeJS.ProcessEnv): string {
  return environment.GROK_HOME ?? join(homedir(), '.grok');
}

/** Location of Grok's durable structured update stream for one cwd/session. */
export function grokUpdatesPath(cwd: string, sessionId: string, grokHome = process.env.GROK_HOME): string {
  return join(grokHome ?? join(homedir(), '.grok'), 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl');
}

/**
 * The relocation rule, stated once for both shells below: a session's directory may sit in a cwd bucket other than
 * the one its log was expected in. From the expected log path, the candidates are the same session id's directory in
 * each cwd bucket of the same sessions root (this one), and a candidate is the session when it holds a summary.json
 * (`relocationCandidate`). The shells differ only in their I/O.
 */
function relocationRoot(updatesPath: string): string {
  return dirname(dirname(dirname(updatesPath)));
}

/** One cwd bucket's candidate under the relocation rule: the session id's directory there, and the file marking it. */
function relocationCandidate(updatesPath: string, bucket: string): { directory: string; marker: string } {
  const directory = join(relocationRoot(updatesPath), bucket, basename(dirname(updatesPath)));
  return { directory, marker: join(directory, 'summary.json') };
}

/**
 * The relocation rule's synchronous shell, for the replay boundary, which is measured once, when a session is opened:
 * the session's directory in the first cwd bucket that holds it, undefined when the sessions root cannot be read or no
 * bucket holds the session.
 */
function locateGrokSessionDirectory(updatesPath: string): string | undefined {
  let buckets: string[];
  try {
    buckets = readdirSync(relocationRoot(updatesPath));
  } catch {
    // No sessions root yet: no session to find.
    return undefined;
  }
  for (const bucket of buckets) {
    const { directory, marker } = relocationCandidate(updatesPath, bucket);
    if (existsSync(marker)) return directory;
  }
  return undefined;
}

/**
 * The relocation rule's asynchronous shell, for the observer's polls: the session's directory in the first cwd bucket
 * that holds it, undefined when the sessions root cannot be read or no bucket holds the session. The observer searches
 * at most once a second while summary.json or updates.jsonl is missing where it reads them, which for a fresh
 * session's log is until its first prompt, so this search never blocks the host's event loop.
 */
export async function findGrokSessionDirectory(updatesPath: string): Promise<string | undefined> {
  let buckets: string[];
  try {
    buckets = await readdir(relocationRoot(updatesPath));
  } catch {
    // The next regular poll retries.
    return undefined;
  }
  for (const bucket of buckets) {
    const { directory, marker } = relocationCandidate(updatesPath, bucket);
    try {
      await stat(marker);
      return directory;
    } catch {
      // Continue scanning cwd buckets.
    }
  }
  return undefined;
}

/**
 * A session's replay boundary: its log's size as it stands now, at the expected path or, when no log is there, in the
 * directory `locateGrokSessionDirectory` finds. A record whose first byte lies below it is history, and every later
 * record is live. No log anywhere is 0. It is measured once, when the session is opened and before a prompt can reach
 * Grok through the binding, so it is synchronous. A log that exists but cannot be measured throws: the line is never
 * guessed.
 */
export function measureGrokReplayBoundary(updatesPath: string): number {
  const size = statSync(updatesPath, { throwIfNoEntry: false })?.size;
  if (size !== undefined) return size;
  const directory = locateGrokSessionDirectory(updatesPath);
  if (directory === undefined) return 0;
  return statSync(join(directory, 'updates.jsonl'), { throwIfNoEntry: false })?.size ?? 0;
}

/**
 * A subagent's child session is a sibling directory in the same cwd bucket
 * whose summary.json says `session_kind: "subagent"` (1.0.0 and 1.0.70). It is
 * not a conversation a person continues. A missing or unreadable summary keeps
 * the session a candidate.
 */
async function isSubagentSession(sessionDirectory: string): Promise<boolean> {
  try {
    const summary = JSON.parse(await readFile(join(sessionDirectory, 'summary.json'), 'utf8')) as unknown;
    return (
      summary !== null &&
      typeof summary === 'object' &&
      (summary as { session_kind?: unknown }).session_kind === 'subagent'
    );
  } catch {
    return false;
  }
}

/** Resolve Grok's cwd-scoped most recently updated top-level session. */
export async function latestGrokSessionId(cwd: string, grokHome = process.env.GROK_HOME): Promise<string | undefined> {
  const root = join(grokHome ?? join(homedir(), '.grok'), 'sessions', encodeURIComponent(cwd));
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const candidates = await Promise.all(
    entries.map(async (sessionId) => {
      try {
        const info = await stat(join(root, sessionId, 'updates.jsonl'));
        if (await isSubagentSession(join(root, sessionId))) return undefined;
        return { sessionId, updatedAt: info.mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  return candidates
    .filter((candidate): candidate is { sessionId: string; updatedAt: number } => candidate !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.sessionId;
}
