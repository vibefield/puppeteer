import type { AgentEvent } from '@vibecook/puppeteer-core';
import { boundedHermesMapSet, hermesString } from './types.js';

/** Owns live-gateway ↔ stored-session correlation and session lifecycle state. */
export class HermesSessionNormalizer {
  private started = false;
  private ready = false;
  private readonly storedByLive = new Map<string, string>();

  bindStoredSession(liveSessionId: string, storedSessionId: string): void {
    boundedHermesMapSet(this.storedByLive, liveSessionId, storedSessionId);
  }

  nativeSessionId(liveSessionId: string | undefined, payload: Record<string, unknown>): string | undefined {
    const stored =
      (liveSessionId ? this.storedByLive.get(liveSessionId) : undefined) ?? hermesString(payload.stored_session_id);
    if (liveSessionId && stored) this.bindStoredSession(liveSessionId, stored);
    return stored ?? liveSessionId;
  }

  acknowledge(nativeSessionId: string | undefined): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (!this.started && nativeSessionId) {
      this.started = true;
      events.push({ type: 'session.started', nativeSessionId });
    }
    if (!this.ready) {
      this.ready = true;
      events.push({ type: 'session.ready' });
    }
    return events;
  }
}
