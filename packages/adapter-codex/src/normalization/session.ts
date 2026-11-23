import type { SessionEvent } from '@vibefield/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, rec, str } from './types.js';

/** Codex thread lifecycle -> Core session events. */
export class CodexSessionNormalizer {
  normalize(input: CodexNormalizationInput): CategoryNormalization<SessionEvent> {
    const events: SessionEvent[] = [];
    switch (input.method) {
      case 'thread/started': {
        const thread = rec(input.params.thread);
        // The thread's name is its title. Its preview is its first words, which the thread's own lists show beside a
        // name and never as one, so an unnamed thread starts with no title.
        const name = str(thread?.name)?.trim();
        events.push({
          type: 'session:started',
          nativeSessionId: str(thread?.id) ?? input.threadId,
          ...(name ? { title: name } : {}),
        });
        return { handled: true, events };
      }
      case 'thread/name/updated': {
        // A rename by the person, by any client of the app-server, or by Codex; null says the thread has none now.
        const name = str(input.params.threadName)?.trim();
        events.push({ type: 'session:title-updated', title: name ? name : null });
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
