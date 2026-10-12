import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  materializeShims,
  writeRendezvous,
  type MaterializeShimsOptions,
  type WriteRendezvousOptions,
} from '@vibefield/puppeteer-runtime/spawn-through';

/**
 * How often a running Godview publishes its shim home again. The home is under
 * the system temp directory, whose cleaner deletes the files there that were
 * not accessed for about three days (macOS, nightly) and leaves the
 * directories; Godview runs for days (docs/guides/spawn-through-hosts.md §3).
 */
export const SHIM_HOME_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/** What Godview published its home with at its start: a refresh publishes exactly these again. */
export interface ShimHomeValues {
  materialize: MaterializeShimsOptions;
  rendezvous: WriteRendezvousOptions;
}

/** Each file under the home, as the inode that holds it: the kit publishes a file by renaming a new one over it. */
async function filesOf(home: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  let entries;
  try {
    entries = await readdir(home, { recursive: true, withFileTypes: true });
  } catch {
    // No home at all: whatever the refresh writes is restored.
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    try {
      files.set(path, (await stat(path)).ino);
    } catch {
      // Gone between the listing and the stat: absent.
    }
  }
  return files;
}

/**
 * Publish the home again with the values it started with, and count the files
 * it brought back. Both calls are idempotent, so a home nothing touched is
 * rewritten by nothing and counts 0.
 */
export async function refreshShimHome(values: ShimHomeValues): Promise<number> {
  const { home } = values.materialize;
  const before = await filesOf(home);
  await materializeShims(values.materialize);
  await writeRendezvous(home, values.rendezvous);
  let restored = 0;
  for (const [path, inode] of await filesOf(home)) if (before.get(path) !== inode) restored += 1;
  return restored;
}

export type ShimHomeRefreshOutcome = { restored: number } | { error: unknown };

/** The one line Godview logs for a refresh that restored anything; nothing for one that did not. */
export function describeShimHomeRefresh(restored: number): string | undefined {
  return restored > 0 ? `spawn-through home: ${restored} ${restored === 1 ? 'file' : 'files'} restored` : undefined;
}

export interface ShimHomeRefresh {
  /** Clear the timer and wait for a refresh in flight: after it, nothing writes the home. */
  stop(): Promise<void>;
}

/**
 * Refresh the home every `intervalMs` until stopped, one refresh at a time,
 * each reported once (`report` must not throw). The timer is unref'd: it never
 * keeps Godview alive.
 */
export function startShimHomeRefresh(
  values: ShimHomeValues,
  report: (outcome: ShimHomeRefreshOutcome) => void,
  intervalMs = SHIM_HOME_REFRESH_INTERVAL_MS,
): ShimHomeRefresh {
  let running: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    let outcome: ShimHomeRefreshOutcome;
    try {
      outcome = { restored: await refreshShimHome(values) };
    } catch (error) {
      outcome = { error };
    }
    report(outcome);
  };
  const timer = setInterval(() => {
    running ??= refresh().finally(() => {
      running = undefined;
    });
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
