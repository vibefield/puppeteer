import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureJsonlBoundary } from '@vibecook/puppeteer-native-observation';
import { antigravityPrompt, antigravityRecord } from '../normalization/types.js';
export interface AntigravitySessionLocation {
  sessionId: string;
  sessionDir: string;
  transcriptPath: string;
}
export function resolveAntigravityDataRoot(options: { home?: string; dataRoot?: string } = {}): string {
  return resolve(
    options.dataRoot ??
      join(options.home ?? process.env.PUPPETEER_ANTIGRAVITY_HOME ?? homedir(), '.gemini', 'antigravity-cli'),
  );
}
export function antigravitySessionLocation(root: string, sessionId: string): AntigravitySessionLocation {
  const sessionDir = join(root, 'brain', sessionId);
  return { sessionId, sessionDir, transcriptPath: join(sessionDir, '.system_generated', 'logs', 'transcript.jsonl') };
}
export async function listAntigravitySessions(root: string): Promise<AntigravitySessionLocation[]> {
  const brain = join(root, 'brain');
  let entries;
  try {
    entries = await readdir(brain, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const results: Array<AntigravitySessionLocation & { mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const location = antigravitySessionLocation(root, entry.name);
    try {
      results.push({ ...location, mtimeMs: (await stat(location.transcriptPath)).mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs).map(({ mtimeMs: _, ...location }) => location);
}
export async function captureAntigravityReplayBoundary(location: AntigravitySessionLocation): Promise<number> {
  return captureJsonlBoundary(location.transcriptPath);
}
export async function transcriptContainsPrompt(
  path: string,
  prompt: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const size = Math.min((await handle.stat()).size, maxBytes);
    const bytes = Buffer.alloc(size);
    const { bytesRead } = await handle.read(bytes, 0, size, 0);
    for (const line of bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
      if (!line) continue;
      try {
        const body = antigravityRecord(JSON.parse(line));
        if (body?.type === 'USER_INPUT' && antigravityPrompt(body.content) === prompt) return true;
      } catch {}
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
