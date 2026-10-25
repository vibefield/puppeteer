/**
 * The switches in a person's own settings that decide whether the managed hooks reach the bridge
 * (packages/surface/vendors/claude/findings.md §7.5: probed on 2.1.283, and F01–F11 reproduced
 * live on 2.1.308 in probes/claude@2.1.308/hook-switches.json). For each key the last enabled
 * layer that states it wins (user < project < local); the launch's own `--settings` ranks above
 * all three, and managed policy above that.
 *
 * - `disableAllHooks: true` — no settings hook fires, the managed ones included (live F05, F08).
 *   A `disableAllHooks: false` in the launch's own settings turns them back on, but turns the
 *   person's own hooks and status line back on with them (F06), so a launch, typed or a host's
 *   own, is refused instead of changed.
 * - `allowedHttpHookUrls` — an HTTP hook to a URL no entry matches is blocked (F09).
 * - `httpHookAllowedEnvVars` — a header variable not listed is not interpolated, so the bearer
 *   never arrives (F10).
 *
 * The two lists are the person's to keep: the launch's own settings restate each with the bridge's
 * entry added (F11), so every HTTP hook of theirs is allowed and interpolated exactly as before.
 */

import { readFile } from 'node:fs/promises';
import {
  claudeSettingsLayers,
  type ClaudeSettingSource,
  type ResolveClaudeStatusChannelsOptions,
} from '../observation/status-channel.js';

export interface ClaudeHookSwitches {
  /** The layer whose `disableAllHooks: true` is in force. */
  hooksOff?: { source: ClaudeSettingSource; path: string } | undefined;
  /** The person's allow-list of HTTP hook URLs, as the layer in force states it. */
  allowedHttpHookUrls?: string[] | undefined;
  /** The person's allow-list of variables an HTTP hook header may name, as the layer in force states it. */
  httpHookAllowedEnvVars?: string[] | undefined;
}

async function settingsFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const strings = (value: unknown[]): string[] => value.filter((entry): entry is string => typeof entry === 'string');

/** Read the person's hook switches from the settings layers a launch reads. */
export async function readClaudeHookSwitches(
  cwd: string,
  options: ResolveClaudeStatusChannelsOptions = {},
): Promise<ClaudeHookSwitches> {
  let hooksOff: ClaudeHookSwitches['hooksOff'];
  let allowedHttpHookUrls: string[] | undefined;
  let httpHookAllowedEnvVars: string[] | undefined;
  for (const { source, path } of claudeSettingsLayers(cwd, options)) {
    const settings = await settingsFile(path);
    if (!settings) continue;
    if (settings.disableAllHooks !== undefined) {
      hooksOff = settings.disableAllHooks === true ? { source, path } : undefined;
    }
    if (Array.isArray(settings.allowedHttpHookUrls)) allowedHttpHookUrls = strings(settings.allowedHttpHookUrls);
    if (Array.isArray(settings.httpHookAllowedEnvVars)) {
      httpHookAllowedEnvVars = strings(settings.httpHookAllowedEnvVars);
    }
  }
  return {
    ...(hooksOff ? { hooksOff } : {}),
    ...(allowedHttpHookUrls ? { allowedHttpHookUrls } : {}),
    ...(httpHookAllowedEnvVars ? { httpHookAllowedEnvVars } : {}),
  };
}
