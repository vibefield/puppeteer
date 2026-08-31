import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotRecord, copilotString } from './types.js';

export function normalizeCopilotSession(type: string, data: Record<string, unknown>): AgentEvent[] | undefined {
  if (type !== 'session.start' && type !== 'session.resume') return undefined;
  const context = copilotRecord(data.context);
  const nativeSessionId = type === 'session.start' ? copilotString(data.sessionId) : undefined;
  const cwd = copilotString(context?.cwd);
  return [
    { type: 'session:started', ...(nativeSessionId ? { nativeSessionId } : {}), startSource: type },
    ...(cwd ? ([{ type: 'environment:updated', currentCwd: cwd }] as const) : []),
  ];
}
