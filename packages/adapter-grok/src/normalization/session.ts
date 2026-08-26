import type { GrokObservedEvent, GrokObservedFactory, GrokUpdate } from './types.js';

/** Grok hook session boundaries -> Core session events. */
export function normalizeGrokSessionHook(
  update: GrokUpdate,
  sessionId: string | undefined,
  observed: GrokObservedFactory,
): GrokObservedEvent[] {
  if (update.event_name === 'session_start') {
    return [observed({ type: 'session:started', nativeSessionId: sessionId }, undefined)];
  }
  if (update.event_name === 'session_end') {
    const reason = typeof update.reason === 'string' ? update.reason.trim() : '';
    return [observed({ type: 'session:exited', ...(reason ? { reason } : {}) }, undefined)];
  }
  return [];
}
