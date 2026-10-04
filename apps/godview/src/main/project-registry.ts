import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectIdentityStore } from '@vibecook/puppeteer-monitor';
import { workspaceIdentity } from '@vibecook/puppeteer-workspaces';
import type { AgentProjectRef } from '../protocol.js';

/**
 * The projects Godview has seen an agent run in, in the order it first saw
 * them (design-system record §02).
 *
 * A colour belongs to a project, and a project is born the first time an
 * agent runs in a folder: this registry deals the sequence number the
 * renderer turns into a hue, and keeps it for life. The sequence is never
 * reused, so adding, removing or renaming a project moves nobody else's
 * colour (P-1), and the key is the canonical source root, so worktrees and
 * copies fold into the repository they were cut from and a subfolder launch
 * folds into its repository (P-4: everything in the folder inherits).
 *
 * Main owns this because identity is main's: the renderer never resolves a
 * path, and a pane never deals itself a hue. The file is host preference,
 * read the way this app reads every persisted document — tolerantly, dropping
 * what it cannot verify rather than refusing to start.
 */

export const PROJECT_REGISTRY_VERSION = 1 as const;

const MAX_REGISTRY_FILE_BYTES = 1024 * 1024;
const MAX_PROJECTS = 4096;
const MAX_KEY_LENGTH = 4096;
const TEMP_PREFIX = '.projects-';

export interface ProjectRecord extends AgentProjectRef {
  /** ISO time the first agent ran here. */
  firstSeenAt: string;
}

interface ProjectRegistryDocument {
  version: typeof PROJECT_REGISTRY_VERSION;
  projects: ProjectRecord[];
}

export interface ProjectRegistry {
  path: string;
  /** Every dealt project, in sequence order. */
  list(): ProjectRecord[];
  /** The project a workspace source belongs to, dealing a new sequence the first time its root is seen. */
  deal(sourcePath: string): Promise<AgentProjectRef>;
  /** The answer without touching disk or Git, for a source path this registry has already folded. */
  known(sourcePath: string): AgentProjectRef | undefined;
  /** The project of a key that is ALREADY a canonical root, dealt at once if it is new: no Git, no fold. */
  dealRoot(key: string): AgentProjectRef;
}

export interface ProjectRegistryOptions {
  /** How a source path folds to its project root; the default is the workspace identity (realpath, then the Git toplevel). */
  resolveRoot?: (sourcePath: string) => Promise<string>;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function projectRef(record: ProjectRecord): AgentProjectRef {
  return { key: record.key, name: record.name, seq: record.seq };
}

/** Accepts only well-formed records with unique keys and sequences; everything else is dropped. */
export function parseProjectRegistry(value: unknown): ProjectRecord[] {
  const document = isRecord(value) ? value : undefined;
  if (!document || document.version !== PROJECT_REGISTRY_VERSION || !Array.isArray(document.projects)) return [];
  const records: ProjectRecord[] = [];
  const keys = new Set<string>();
  const sequences = new Set<number>();
  for (const entry of document.projects) {
    if (records.length >= MAX_PROJECTS) break;
    if (!isRecord(entry)) continue;
    const { key, name, seq, firstSeenAt } = entry;
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH || !isAbsolute(key)) continue;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) continue;
    if (typeof firstSeenAt !== 'string' || Number.isNaN(Date.parse(firstSeenAt))) continue;
    if (keys.has(key) || sequences.has(seq)) continue;
    keys.add(key);
    sequences.add(seq);
    records.push({ key, name, seq, firstSeenAt });
  }
  return records.sort((left, right) => left.seq - right.seq);
}

export function serializeProjectRegistry(projects: readonly ProjectRecord[]): string {
  const document: ProjectRegistryDocument = {
    version: PROJECT_REGISTRY_VERSION,
    projects: [...projects].sort((left, right) => left.seq - right.seq),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The next sequence: one past the highest ever dealt, so a removed entry's number is never dealt again. */
export function nextProjectSequence(projects: readonly ProjectRecord[]): number {
  return projects.reduce((highest, project) => Math.max(highest, project.seq + 1), 0);
}

function readRegistryFile(path: string): ProjectRecord[] {
  try {
    if (!existsSync(path)) return [];
    if (statSync(path).size > MAX_REGISTRY_FILE_BYTES) return [];
    return parseProjectRegistry(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    // A corrupt registry must not stop agents from launching; the projects it
    // named are dealt again, in a new order, which is the one loss possible.
    return [];
  }
}

function writeRegistryFile(path: string, projects: readonly ProjectRecord[]): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `${TEMP_PREFIX}${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, serializeProjectRegistry(projects), 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

/**
 * The canonical source root: the real path, folded to the Git toplevel when
 * the folder is inside a repository. A path that cannot be resolved (gone,
 * or not a directory) keeps its absolute form, so a project is still dealt.
 */
export async function canonicalProjectRoot(sourcePath: string): Promise<string> {
  try {
    return await workspaceIdentity(sourcePath);
  } catch {
    return resolve(sourcePath);
  }
}

/** File-backed, with the whole registry in memory so a launch never waits on a read. */
export function createProjectRegistry(path: string, options: ProjectRegistryOptions = {}): ProjectRegistry {
  const resolveRoot = options.resolveRoot ?? canonicalProjectRoot;
  const now = options.now ?? (() => new Date());
  let projects = readRegistryFile(path);
  const byKey = new Map(projects.map((project) => [project.key, project] as const));
  /** Source path -> the root it folded to, so a second agent in the same folder never asks Git again. */
  const rootsBySource = new Map<string, string>();
  /** Deals are serialized: two agents starting at once in a new folder must share one sequence. */
  let dealing: Promise<unknown> = Promise.resolve();

  const dealRoot = (key: string): AgentProjectRef => {
    const existing = byKey.get(key);
    if (existing) return projectRef(existing);
    const record: ProjectRecord = {
      key,
      name: basename(key) || key,
      seq: nextProjectSequence(projects),
      firstSeenAt: now().toISOString(),
    };
    projects = [...projects, record];
    byKey.set(key, record);
    try {
      writeRegistryFile(path, projects);
    } catch (error) {
      // The deal stands for this run even when it could not be written; the
      // project is dealt again after a restart, which only costs its colour.
      process.stderr.write(`[main] could not persist the project registry: ${(error as Error).message}\n`);
    }
    return projectRef(record);
  };

  return {
    path,
    list: () => projects.map((project) => ({ ...project })),
    dealRoot,
    known(sourcePath) {
      const key = rootsBySource.get(sourcePath) ?? (byKey.has(sourcePath) ? sourcePath : undefined);
      if (!key) return undefined;
      const record = byKey.get(key);
      return record ? projectRef(record) : undefined;
    },
    deal(sourcePath) {
      const known = this.known(sourcePath);
      if (known) return Promise.resolve(known);
      const next = dealing.then(async () => {
        const key = rootsBySource.get(sourcePath) ?? (await resolveRoot(sourcePath));
        rootsBySource.set(sourcePath, key);
        return dealRoot(key);
      });
      dealing = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * The registry as the monitor backend's identity port (L4). The backend keys a
 * run by its host's canonical root (`info.project.key`, which this registry
 * dealt), so a key is always known; a new one would be dealt as a root.
 * Persistence stays the registry's: the backend only asks.
 */
export function projectIdentityStore(registry: ProjectRegistry): ProjectIdentityStore {
  return {
    seq: (key) => registry.known(key)?.seq,
    deal: (key) => registry.known(key)?.seq ?? registry.dealRoot(key).seq,
  };
}
