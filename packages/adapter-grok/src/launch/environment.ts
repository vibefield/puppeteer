import type { AgentHost } from '@vibefield/puppeteer-core';

/**
 * The one computation of a Grok helper's environment. The leader and its ACP controller run the agent's turns and
 * tools, so under a host that composes a helper environment they get the agent's, never this process's own. Without
 * one, `extras` go over this process's, and no extras leave the helper inheriting it (`undefined`). The backend spawns
 * under this answer, and the continuation records the home it names.
 */
export function grokHelperEnvironment(
  host: Pick<AgentHost, 'helperEnvironment'>,
  extras: Record<string, string> | undefined,
): NodeJS.ProcessEnv | undefined {
  return host.helperEnvironment?.(extras ?? {}) ?? (extras ? { ...process.env, ...extras } : undefined);
}
