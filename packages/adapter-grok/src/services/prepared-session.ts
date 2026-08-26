import type { AgentAdapterSession, TerminalSpec } from '@vibecook/puppeteer-core';
import type { GrokConfiguredIntent } from '../monitor-evidence.js';
import type { GrokSessionObserver } from '../session-observer.js';
import type { PreparedGrokSession } from '../types.js';
import { createPendingControlSession } from './control-session.js';

/** Binds one prepared Grok launch recipe to exactly one caller-owned terminal. */
export function createPreparedGrokSession(
  sessionId: string,
  launch: TerminalSpec,
  attach: () => AgentAdapterSession | Promise<AgentAdapterSession>,
  disposeUnadopted?: () => void | Promise<void>,
  observe?: () => GrokSessionObserver,
  configured: GrokConfiguredIntent = {},
): PreparedGrokSession {
  let adoptedRuntimeSessionId: string | undefined;
  let adoptedSession: AgentAdapterSession | undefined;
  let disposed = false;

  return {
    sessionId,
    launch,
    async adopt(runtimeSessionId): Promise<AgentAdapterSession> {
      if (disposed) throw new Error('prepared Grok session is disposed');
      if (adoptedRuntimeSessionId && adoptedRuntimeSessionId !== runtimeSessionId) {
        throw new Error(`prepared Grok session is already adopted by ${adoptedRuntimeSessionId}`);
      }
      if (adoptedSession) return adoptedSession;
      adoptedRuntimeSessionId = runtimeSessionId;
      adoptedSession = createPendingControlSession(sessionId, runtimeSessionId, attach, observe?.(), configured);
      return adoptedSession;
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (adoptedSession) await adoptedSession.dispose().catch(() => undefined);
      else await Promise.resolve(disposeUnadopted?.()).catch(() => undefined);
    },
  };
}
