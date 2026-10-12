import { lstat, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** A shim home's exact name: `godview-agent-shims-<pid>`, the pid as a process prints it. */
const SHIM_HOME = /^godview-agent-shims-([1-9]\d{0,9})$/u;

/**
 * Homes examined per start. Only names are read for the rest of the temp
 * directory, which can hold tens of thousands of entries.
 */
export const SHIM_HOME_SWEEP_LIMIT = 256;

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists and belongs to someone else — alive, not ours to judge.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ShimHomeSweep {
  /** Entries named exactly like a home that were looked at, at most the limit. */
  examined: number;
  removed: string[];
  failed: { path: string; message: string }[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove the shim homes of Godviews that never reached their own cleanup — a
 * crash, a kill, an OS logout, a smoke that failed: each
 * `godview-agent-shims-<pid>` directory in `directory` whose pid is gone. A
 * link named like a home is unlinked, never followed; nothing else is touched;
 * a home that cannot be removed is reported and the sweep goes on. Never throws.
 */
export async function sweepStaleShimHomes(
  directory: string,
  { isAlive = pidIsAlive, limit = SHIM_HOME_SWEEP_LIMIT }: { isAlive?: (pid: number) => boolean; limit?: number } = {},
): Promise<ShimHomeSweep> {
  const sweep: ShimHomeSweep = { examined: 0, removed: [], failed: [] };
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    sweep.failed.push({ path: directory, message: messageOf(error) });
    return sweep;
  }
  for (const name of names) {
    const pid = Number(SHIM_HOME.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid)) continue;
    if (sweep.examined >= limit) break;
    sweep.examined += 1;
    if (pid === process.pid || isAlive(pid)) continue;
    const path = join(directory, name);
    try {
      const status = await lstat(path);
      if (status.isSymbolicLink()) await unlink(path);
      else if (status.isDirectory()) await rm(path, { recursive: true, force: true });
      else continue;
      sweep.removed.push(path);
    } catch (error) {
      sweep.failed.push({ path, message: messageOf(error) });
    }
  }
  return sweep;
}
