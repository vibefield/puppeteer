import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Location of Grok's durable structured update stream for one cwd/session. */
export function grokUpdatesPath(cwd: string, sessionId: string, grokHome = process.env.GROK_HOME): string {
  return join(grokHome ?? join(homedir(), '.grok'), 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl');
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
