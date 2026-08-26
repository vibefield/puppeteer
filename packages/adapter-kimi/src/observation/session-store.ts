/** Read-only addressing helpers for Kimi Code's v2 durable session store. */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

export interface KimiSessionIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

export interface KimiSessionLocation extends KimiSessionIndexEntry {
  wirePath: string;
  statePath: string;
}

export interface KimiAgentJournal {
  agentId: string;
  path: string;
}

export type KimiJournalOffsets = ReadonlyMap<string, number>;

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;
const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;

export function resolveKimiHome(
  configured?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolve(configured ?? env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'));
}

/** Exact 0.34.0 workdir bucket algorithm (`wd_<slug>_<sha256-12>`). */
export function normalizeKimiWorkDir(workDir: string): string {
  if (WINDOWS_ABSOLUTE.test(workDir)) return win32.resolve(workDir).replaceAll('\\', '/');
  if (workDir.startsWith('/')) return posix.resolve(workDir);
  return resolve(workDir);
}

export function encodeKimiWorkDirKey(workDir: string): string {
  const normalized = normalizeKimiWorkDir(workDir);
  const name = posix.basename(normalized);
  const candidate = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  const slug = candidate === '' || candidate === '.' || candidate === '..' ? 'workspace' : candidate;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${slug}_${hash}`;
}

export function kimiMainWirePath(sessionDir: string): string {
  return join(sessionDir, 'agents', 'main', 'wire.jsonl');
}

function safeComponent(value: string): boolean {
  return value !== '.' && value !== '..' && SAFE_COMPONENT.test(value);
}

function canonicalPath(value: string): string {
  const normalized = normalizeKimiWorkDir(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return WINDOWS_ABSOLUTE.test(value) ? normalized.toLowerCase() : normalized;
}

function sameWorkDir(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function inside(parent: string, child: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const rel = relative(parentPath, childPath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readStateWorkDir(sessionDir: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const state = value as Record<string, unknown>;
    return typeof state.cwd === 'string' ? state.cwd : typeof state.workDir === 'string' ? state.workDir : undefined;
  } catch {
    return undefined;
  }
}

function location(entry: KimiSessionIndexEntry): KimiSessionLocation {
  return {
    ...entry,
    wirePath: kimiMainWirePath(entry.sessionDir),
    statePath: join(entry.sessionDir, 'state.json'),
  };
}

/**
 * Fold Kimi's append-only global index. Invalid, deleted, or escaping entries
 * are ignored; later records for an id replace earlier records.
 */
export async function readKimiSessionIndex(kimiHome: string): Promise<Map<string, KimiSessionIndexEntry>> {
  const home = resolve(kimiHome);
  const sessionsRoot = join(home, 'sessions');
  let raw: string;
  try {
    raw = await readFile(join(home, 'session_index.jsonl'), 'utf8');
  } catch {
    return new Map();
  }
  const entries = new Map<string, KimiSessionIndexEntry>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      if (typeof item.sessionId !== 'string' || !safeComponent(item.sessionId)) continue;
      if (item.deleted === true) {
        entries.delete(item.sessionId);
        continue;
      }
      if (typeof item.sessionDir !== 'string' || typeof item.workDir !== 'string') continue;
      const sessionDir = resolve(item.sessionDir);
      if (!inside(sessionsRoot, sessionDir) || basename(sessionDir) !== item.sessionId) continue;
      entries.set(item.sessionId, { sessionId: item.sessionId, sessionDir, workDir: item.workDir });
    } catch {
      // A torn final append is retried by the next read; corrupt historical
      // lines cannot make an unrelated path eligible for observation.
    }
  }
  return entries;
}

async function scanExpectedBucket(kimiHome: string, cwd: string): Promise<KimiSessionIndexEntry[]> {
  const bucket = join(resolve(kimiHome), 'sessions', encodeKimiWorkDirKey(cwd));
  let names: string[];
  try {
    names = await readdir(bucket);
  } catch {
    return [];
  }
  const entries: KimiSessionIndexEntry[] = [];
  await Promise.all(
    names.map(async (sessionId) => {
      if (!safeComponent(sessionId)) return;
      const sessionDir = join(bucket, sessionId);
      if (!(await isDirectory(sessionDir))) return;
      const stateWorkDir = await readStateWorkDir(sessionDir);
      if (stateWorkDir && !sameWorkDir(stateWorkDir, cwd)) return;
      entries.push({ sessionId, sessionDir, workDir: stateWorkDir ?? normalizeKimiWorkDir(cwd) });
    }),
  );
  return entries;
}

/** Index-first with an exact-bucket fallback (the fallback also serves the Imposter). */
export async function listKimiSessionsForCwd(kimiHome: string, cwd: string): Promise<KimiSessionLocation[]> {
  const entries = await readKimiSessionIndex(kimiHome);
  const combined = new Map<string, KimiSessionIndexEntry>();
  for (const entry of entries.values()) {
    const stateWorkDir = await readStateWorkDir(entry.sessionDir);
    const observedWorkDir = stateWorkDir ?? entry.workDir;
    if (sameWorkDir(observedWorkDir, cwd) && (await isDirectory(entry.sessionDir))) {
      combined.set(entry.sessionId, { ...entry, workDir: observedWorkDir });
    }
  }
  for (const entry of await scanExpectedBucket(kimiHome, cwd)) {
    if (!combined.has(entry.sessionId)) combined.set(entry.sessionId, entry);
  }
  return [...combined.values()].map(location).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export async function findKimiSession(
  kimiHome: string,
  sessionId: string,
  cwd?: string,
): Promise<KimiSessionLocation | undefined> {
  if (!safeComponent(sessionId)) return undefined;
  const indexed = (await readKimiSessionIndex(kimiHome)).get(sessionId);
  if (indexed && (await isDirectory(indexed.sessionDir))) {
    const stateWorkDir = await readStateWorkDir(indexed.sessionDir);
    const workDir = stateWorkDir ?? indexed.workDir;
    if (!cwd || sameWorkDir(workDir, cwd)) return location({ ...indexed, workDir });
  }
  if (!cwd) return undefined;
  return (await scanExpectedBucket(kimiHome, cwd)).map(location).find((entry) => entry.sessionId === sessionId);
}

export async function findKimiAgentJournals(sessionDir: string): Promise<KimiAgentJournal[]> {
  const agentsDir = join(sessionDir, 'agents');
  let names: string[];
  try {
    names = await readdir(agentsDir);
  } catch {
    return [];
  }
  const journals: KimiAgentJournal[] = [];
  for (const agentId of names.sort()) {
    if (!safeComponent(agentId)) continue;
    const path = join(agentsDir, agentId, 'wire.jsonl');
    try {
      if ((await stat(path)).isFile()) journals.push({ agentId, path });
    } catch {
      // A subagent directory can be visible before its journal is created.
    }
  }
  return journals.sort((left, right) => (left.agentId === 'main' ? -1 : right.agentId === 'main' ? 1 : 0));
}

export async function captureKimiJournalOffsets(sessionDir: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const journal of await findKimiAgentJournals(sessionDir)) {
    try {
      result.set(journal.path, (await stat(journal.path)).size);
    } catch {
      // A concurrent append/remove is retried when observation begins.
    }
  }
  return result;
}
