import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotString } from './types.js';

export function normalizeCopilotEnvironment(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (type !== 'session.context_changed') return undefined;
  const currentCwd = copilotString(data.cwd);
  const root = copilotString(data.gitRoot);
  const branch = copilotString(data.branch);
  const headSha = copilotString(data.headCommit);
  return [
    {
      type: 'environment:updated',
      ...(currentCwd ? { currentCwd } : {}),
      ...(root
        ? { git: { root, branch: branch ?? null, headSha: headSha ?? null, detached: !branch && !!headSha } }
        : {}),
    },
  ];
}
