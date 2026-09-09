import { existsSync, readFileSync, statSync } from 'node:fs';
import { validateHistoryOrigin } from './history-search.js';

/**
 * Where the transcript history daemon lives, and whether Godview may ask it.
 *
 * A hand-edited preference: Godview reads it and never writes it, because the
 * daemon is owned by whoever started it, not by this app. Absent or malformed,
 * the defaults apply: enabled, origin discovered from the daemon's own
 * announcement or the app default port. The reader is tolerant in the way
 * this app already validates persisted documents: anything it cannot verify
 * is dropped rather than thrown at start-up.
 */

export const HISTORY_SETTINGS_VERSION = 1 as const;

const MAX_SETTINGS_FILE_BYTES = 64 * 1024;

export interface HistorySettings {
  /** A loopback http origin, when the user pinned one; otherwise discovered. */
  origin?: string;
  enabled: boolean;
}

export const DEFAULT_HISTORY_SETTINGS: HistorySettings = { enabled: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHistorySettings(value: unknown): HistorySettings {
  if (!isRecord(value) || value.version !== HISTORY_SETTINGS_VERSION) return { ...DEFAULT_HISTORY_SETTINGS };
  const origin = validateHistoryOrigin(value.origin);
  return {
    ...(origin ? { origin } : {}),
    enabled: value.enabled !== false,
  };
}

export interface HistorySettingsStore {
  path: string;
  read(): HistorySettings;
}

export function createHistorySettingsStore(path: string): HistorySettingsStore {
  return {
    path,
    read(): HistorySettings {
      try {
        if (!existsSync(path)) return { ...DEFAULT_HISTORY_SETTINGS };
        if (statSync(path).size > MAX_SETTINGS_FILE_BYTES) return { ...DEFAULT_HISTORY_SETTINGS };
        return parseHistorySettings(JSON.parse(readFileSync(path, 'utf8')) as unknown);
      } catch {
        // A corrupt preference file must not stop the sheet from opening; it
        // simply means the defaults apply.
        return { ...DEFAULT_HISTORY_SETTINGS };
      }
    },
  };
}
