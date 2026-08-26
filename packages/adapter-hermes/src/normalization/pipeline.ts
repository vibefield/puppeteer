import type { AgentEvent } from '@vibecook/puppeteer-core';
import { isRetainedHermesEvent, normalizeHermesNative } from './adapter.js';
import { HermesConversationNormalizer } from './conversation.js';
import { normalizeHermesContextWindow } from './context-window.js';
import { normalizeHermesEnvironment } from './environment.js';
import { HermesInteractionNormalizer } from './interaction.js';
import { HermesSessionNormalizer } from './session.js';
import { HermesToolNormalizer } from './tool.js';
import {
  hermesNativeEvent,
  parseHermesFrame,
  type HermesNormalizedRecord,
  type HermesNormalizationDisposition,
} from './types.js';

/** One session-scoped composition of category-focused Hermes normalizers. */
export class HermesGatewayNormalizer {
  private readonly session = new HermesSessionNormalizer();
  private readonly conversation = new HermesConversationNormalizer();
  private readonly tool = new HermesToolNormalizer();
  private readonly interaction = new HermesInteractionNormalizer();

  bindStoredSession(liveSessionId: string, storedSessionId: string): void {
    this.session.bindStoredSession(liveSessionId, storedSessionId);
  }

  acknowledgeSession(nativeSessionId: string): HermesNormalizedRecord {
    const events = this.session.acknowledge(nativeSessionId);
    return this.record(events, {
      nativeSessionId,
      nativeEvent: { reason: 'session.create/resume result' },
    });
  }

  normalize(frame: unknown): HermesNormalizedRecord {
    const parsed = parseHermesFrame(frame);
    const nativeSessionId = this.session.nativeSessionId(parsed.liveSessionId, parsed.payload);
    const currentTurnId = this.conversation.currentTurnId();
    const base = {
      nativeSessionId,
      liveSessionId: parsed.liveSessionId,
      turnId: currentTurnId,
      nativeEvent: frame,
    };
    if (!parsed.type) {
      return this.record([hermesNativeEvent('untyped')], base, 'retained-native');
    }
    const type = parsed.type;
    if (isRetainedHermesEvent(type)) return this.record(normalizeHermesNative(type), base, 'retained-native');

    switch (type) {
      case 'session.info':
        return this.record(
          [
            ...this.session.acknowledge(nativeSessionId),
            ...normalizeHermesEnvironment(parsed.payload),
            ...normalizeHermesContextWindow(parsed.payload),
          ],
          base,
        );
      case 'message.start': {
        const started = this.conversation.start();
        return this.record(started.events, { ...base, turnId: started.turnId });
      }
      case 'message.delta':
        return this.record(this.conversation.delta(parsed.payload), base);
      case 'message.complete': {
        const completed = this.conversation.complete(parsed.payload);
        return this.record(completed.events, { ...base, turnId: completed.turnId });
      }
      case 'tool.start':
        return this.record(this.tool.start(parsed.payload), base);
      case 'tool.complete':
        return this.record(this.tool.complete(parsed.payload), base);
      case 'approval.request':
        return this.record(this.interaction.permission(parsed.payload, parsed.liveSessionId), base);
      case 'clarify.request':
        return this.record(this.interaction.requestQuestion(parsed.payload), base);
      case 'clarify.expire':
        return this.record(this.interaction.expireQuestion(parsed.payload), base);
      default:
        return this.record(normalizeHermesNative(type), base, 'retained-native');
    }
  }

  private record(
    events: AgentEvent[],
    metadata: {
      nativeSessionId?: string;
      liveSessionId?: string;
      turnId?: string;
      nativeEvent: unknown;
    },
    disposition?: HermesNormalizationDisposition,
  ): HermesNormalizedRecord {
    return {
      ...metadata,
      events,
      source: 'native-protocol',
      confidence: 'authoritative',
      disposition: disposition ?? (events.length > 0 ? 'mapped' : 'no-output'),
    };
  }
}
