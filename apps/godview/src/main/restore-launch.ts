import { resolve } from 'node:path';
import type { RestoreClaudeLaunchProvenance } from '../restore-snapshot.js';

const MAX_RESTORE_PATH = 8_192;

/** Normalize Claude's effective config root at the same cwd boundary as its adapter. */
export function claudeRestoreLaunchProvenance(
  configDir: unknown,
  cwd: string,
): RestoreClaudeLaunchProvenance | undefined {
  if (typeof configDir !== 'string') return undefined;
  const normalized = configDir.trim();
  if (!normalized || normalized.length > MAX_RESTORE_PATH) return undefined;
  return { kind: 'claude', configDir: resolve(cwd, normalized) };
}
