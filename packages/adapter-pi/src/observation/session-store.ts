import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureJsonlBoundary } from '@vibecook/puppeteer-native-observation';
import { piRecord, piString } from '../normalization/types.js';

export interface PiSessionLocation {
  sessionId: string;
  path: string;
  sessionDir: string;
  cwd?: string;
}

export function resolvePiAgentDir(explicit?: string): string {
  return resolve(explicit ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'));
}

export function piCwdKey(cwd: string): string {
  return `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`;
}

export function resolvePiSessionDir(cwd: string, agentDir: string, explicit?: string): string {
  return resolve(explicit ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? join(agentDir, 'sessions', piCwdKey(cwd)));
}

async function header(path: string): Promise<Record<string, unknown> | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const line = bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    return line ? piRecord(JSON.parse(line)) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function listPiSessions(sessionDir: string): Promise<PiSessionLocation[]> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const sessions: Array<PiSessionLocation & { mtimeMs: number }> = [];
  for (const name of names.filter((value) => value.endsWith('.jsonl'))) {
    const path = join(sessionDir, name);
    const body = await header(path);
    const sessionId = piString(body?.id);
    if (body?.type !== 'session' || !sessionId) continue;
    sessions.push({
      sessionId,
      path,
      sessionDir,
      ...(piString(body.cwd) ? { cwd: piString(body.cwd) } : {}),
      mtimeMs: (await stat(path)).mtimeMs,
    });
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs).map(({ mtimeMs: _, ...location }) => location);
}

export async function findPiSession(sessionDir: string, sessionId: string): Promise<PiSessionLocation | undefined> {
  const sessions = await listPiSessions(sessionDir);
  const exact = sessions.find((session) => session.sessionId === sessionId);
  if (exact) return exact;
  const prefixes = sessions.filter((session) => session.sessionId.startsWith(sessionId));
  return prefixes.length === 1 ? prefixes[0] : undefined;
}

export async function capturePiReplayBoundary(location: PiSessionLocation): Promise<number> {
  return captureJsonlBoundary(location.path);
}
