import type { SessionEvent } from '@vibefield/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, rec, str } from './types.js';

/** Codex thread lifecycle -> Core session events. */
export class CodexSessionNormalizer {
  normalize(input: CodexNormalizationInput): CategoryNormalization<SessionEvent> {
    const events: SessionEvent[] = [];
    switch (input.method) {
      case 'thread/started': {
        const thread = rec(input.params.thread);
        events.push({
          type: 'session:started',
          nativeSessionId: str(thread?.id) ?? input.threadId,
          title: str(thread?.name) ?? (str(thread?.preview) || undefined),
        });
        return { handled: true, events };
      }
      case 'thread/closed':
        events.push({ type: 'session:exited', reason: 'thread-closed' });
        return { handled: true, events };
      default:
        return { handled: false, events };
    }
  }
}
