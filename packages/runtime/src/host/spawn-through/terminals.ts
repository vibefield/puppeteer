import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ensurePrivateDirectory, publishFile } from './files.js';
import { runPs, startedAtFromPs, type RunPs } from './ps.js';

export type { RunPs } from './ps.js';

/**
 * The shells a host owns, as a file in the shim home. The launcher's directory
 * leaks out of the host's terminals — an editor opened from one of them, a
 * multiplexer's server, a detached job all inherit it — so a strict shim that
 * cannot reach its host reads this file to tell one of the host's terminals,
 * where the host's word holds, from anywhere else, where the agent runs as
 * typed. The host rewrites it whenever a terminal of its own is born or ends.
 */
export const TERMINALS_FILE = 'terminals.json';
/** More shells than a host could own at once: the walk a shim makes stays small. */
const MAX_TERMINALS = 1_024;
/** How far up its ancestors a process is walked. */
const MAX_ANCESTRY = 32;

const TerminalSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1).max(64),
});
const TerminalsSchema = z.object({
  format: z.literal(1),
  writtenAt: z.string().min(1),
  terminals: z.array(TerminalSchema).max(MAX_TERMINALS),
});

/** One shell a host owns: its pid, and its start as `processStartedAt` reports it. */
export interface SpawnThroughTerminal {
  pid: number;
  /** A pid the system reused is not the shell: its start time says so. */
  startedAt: string;
}

/**
 * Publish the shells the host owns (0600, whole or not at all). Throws, before
 * writing, on values no shim could use. Only `pid` and `startedAt` of each are
 * written, so a host can hand over its own terminal records.
 */
export async function writeTerminals(home: string, terminals: readonly SpawnThroughTerminal[]): Promise<void> {
  const file = TerminalsSchema.parse({
    format: 1,
    writtenAt: new Date().toISOString(),
    terminals: terminals.map(({ pid, startedAt }) => ({ pid, startedAt })),
  });
  await ensurePrivateDirectory(home);
  await publishFile(join(home, TERMINALS_FILE), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/** The shells the host lists, or `undefined` when there is no list a shim could use. Never throws. */
export async function readTerminals(home: string): Promise<SpawnThroughTerminal[] | undefined> {
  try {
    const parsed = TerminalsSchema.safeParse(JSON.parse(await readFile(join(home, TERMINALS_FILE), 'utf8')));
    return parsed.success ? parsed.data.terminals : undefined;
  } catch {
    return undefined;
  }
}

export interface ProcessRecord {
  pid: number;
  parentPid: number;
  /** As `processStartedAt` reports it; `undefined` when `ps` gave no date it could read. */
  startedAt: string | undefined;
}

export type ProcessTable = ReadonlyMap<number, ProcessRecord>;

/**
 * One read of the whole process table: every pid, its parent, and when it
 * started — or `undefined` when `ps` cannot say. Never throws.
 */
export async function readProcessTable({ ps = runPs }: { ps?: RunPs | undefined } = {}): Promise<
  ProcessTable | undefined
> {
  let text: string;
  try {
    // One -o per column: BSD ps reads everything after `keyword=` as that column's header.
    text = await ps(['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=']);
  } catch {
    return undefined;
  }
  const table = new Map<number, ProcessRecord>();
  for (const line of text.split('\n')) {
    const columns = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/u.exec(line);
    if (!columns) continue;
    const pid = Number(columns[1]);
    table.set(pid, { pid, parentPid: Number(columns[2]), startedAt: startedAtFromPs(columns[3]!) });
  }
  return table.size > 0 ? table : undefined;
}

/**
 * The first of `owners` that is `pid` or one of its ancestors, matched by pid
 * AND start time, so a pid the system reused owns nothing. The walk is
 * bounded: 32 processes, and a cycle or a pid ≤ 1 ends it. The process table
 * is read once, with `ps`, unless one is given. This is the walk a shim makes
 * when its host cannot answer (is this one of the host's terminals?), and the
 * one a host's own `resolveTerminal` can make (which of mine holds this pid?).
 */
export async function findOwningProcess<Owner extends SpawnThroughTerminal>(options: {
  pid: number;
  owners: readonly Owner[];
  processTable?: ProcessTable | undefined;
  ps?: RunPs | undefined;
}): Promise<Owner | undefined> {
  const { pid, owners } = options;
  if (owners.length === 0) return undefined;
  const table = options.processTable ?? (await readProcessTable({ ps: options.ps }));
  if (!table) return undefined;
  const walked = new Set<number>();
  let current = pid;
  while (walked.size < MAX_ANCESTRY && current > 1 && !walked.has(current)) {
    walked.add(current);
    const record = table.get(current);
    if (!record) return undefined;
    const owner = owners.find((candidate) => candidate.pid === current && candidate.startedAt === record.startedAt);
    if (owner) return owner;
    current = record.parentPid;
  }
  return undefined;
}
