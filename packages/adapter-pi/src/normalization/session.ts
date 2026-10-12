import type { AgentEvent } from '@vibefield/puppeteer-core';
import { piString } from './types.js';

export function normalizePiSession(body: Record<string, unknown>): AgentEvent[] | undefined {
  if (body.type !== 'session') return undefined;
  const nativeSessionId = piString(body.id);
  const cwd = piString(body.cwd);
  return [
    { type: 'session:started', ...(nativeSessionId ? { nativeSessionId } : {}), startSource: 'session-header' },
    ...(cwd ? ([{ type: 'environment:updated', currentCwd: cwd }] as const) : []),
  ];
}
