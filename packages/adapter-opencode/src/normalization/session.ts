import type { AgentEvent } from '@vibecook/puppeteer-core';
import { openCodeText } from './wire.js';

export function normalizeOpenCodeSessionStarted(info: Record<string, unknown>, sessionID: string): AgentEvent {
  const title = openCodeText(info.title);
  return {
    type: 'session:started',
    nativeSessionId: sessionID,
    ...(title ? { title } : {}),
  };
}

export function normalizeOpenCodeSessionExited(): AgentEvent {
  return { type: 'session:exited', reason: 'deleted' };
}
