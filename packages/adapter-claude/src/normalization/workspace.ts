import type { AgentEvent } from '@vibecook/puppeteer-core';

export function normalizeClaudeWorkspaceChanged(path: string | undefined): AgentEvent | undefined {
  return path ? { type: 'workspace.changed', paths: [path] } : undefined;
}
