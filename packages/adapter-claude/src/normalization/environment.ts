import type { EnvironmentEvent } from '@vibefield/puppeteer-core';
import type { ClaudeHookPayload } from './types.js';
import { claudeString } from './wire.js';

export function normalizeClaudeSessionEnvironment(body: ClaudeHookPayload): EnvironmentEvent | undefined {
  const currentCwd = claudeString(body.cwd);
  return currentCwd ? { type: 'environment:updated', currentCwd } : undefined;
}

export function normalizeClaudeCwd(body: ClaudeHookPayload): EnvironmentEvent | undefined {
  const currentCwd = claudeString(body.new_cwd) ?? claudeString(body.cwd);
  return currentCwd ? { type: 'environment:updated', currentCwd } : undefined;
}
