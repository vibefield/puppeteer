import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Location of Grok's durable structured update stream for one cwd/session. */
export function grokUpdatesPath(cwd: string, sessionId: string, grokHome = process.env.GROK_HOME): string {
  return join(grokHome ?? join(homedir(), '.grok'), 'sessions', encodeURIComponent(cwd), sessionId, 'updates.jsonl');
}

/** Resolve Grok's cwd-scoped most recently updated session. */
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
