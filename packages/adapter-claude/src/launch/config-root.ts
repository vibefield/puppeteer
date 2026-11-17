/**
 * Where a Claude process keeps its configuration and conversations, read one way by a launch (its settings layers,
 * the CLAUDE_CONFIG_DIR it is given, a resume's check), an attach and the transcript pin (session-selection.ts).
 *
 * The config dir is an explicit one, else the launch environment's CLAUDE_CONFIG_DIR, which the process inherits,
 * else this process's. Claude interprets a relative one from the launched process's cwd, so it is resolved at that
 * boundary: an Electron or daemon cwd never selects another root. With none named, Claude uses `<home>/.claude`. The
 * imposter keeps the same layout under its own state root (`PUPPETEER_IMPOSTER_HOME`).
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ClaudeConfigRootOptions {
  /** The launched process's working directory. */
  cwd: string;
  /** An explicit config dir (a typed launch's or a profile's). */
  configDir?: string | undefined;
  /** The launch environment, which the process inherits. */
  env?: Readonly<Record<string, string>> | undefined;
  /** The home `.claude` hangs off when no config dir is named; this process's when absent. */
  home?: string | undefined;
}

/** The config dir a launch hands Claude, resolved; undefined when none is named. */
export function claudeConfigDirectory(options: ClaudeConfigRootOptions): string | undefined {
  const named = (options.configDir ?? options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR)?.trim();
  return named ? resolve(options.cwd, named) : undefined;
}

/** The root Claude keeps a conversation under, as `projects/<cwd slug>/<session id>.jsonl`. */
export function claudeConfigRoot(options: ClaudeConfigRootOptions): string {
  const imposterHome = options.env?.PUPPETEER_IMPOSTER_HOME;
  if (imposterHome !== undefined) return resolve(options.cwd, imposterHome);
  return claudeConfigDirectory(options) ?? join(options.home ?? homedir(), '.claude');
}
