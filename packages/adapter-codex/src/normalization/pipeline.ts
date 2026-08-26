/**
 * Codex app-server notification → canonical Core event pipeline.
 *
 * Each category normalizer owns only its upper-level event contract. The
 * pipeline owns cross-category correlation and preserves deterministic emission
 * order when one native notification produces several categories.
 */

import type { AgentEvent } from '@vibecook/puppeteer-core';
import { CodexAdapterFallbackNormalizer } from './adapter.js';
import { CodexContextWindowNormalizer } from './context-window.js';
import { CodexConversationNormalizer } from './conversation.js';
import { CodexEnvironmentNormalizer } from './environment.js';
import { CodexNotificationEventNormalizer } from './notification.js';
import { CodexStateNormalizer } from './state.js';
import {
  type CodexNormalizationInput,
  type CodexServerNotification,
  type NormalizedNotification,
  rec,
  str,
} from './types.js';

export type { CodexServerNotification, NormalizedNotification } from './types.js';

/** One session-scoped composition of otherwise category-focused normalizers. */
export class CodexNotificationNormalizer {
  private readonly state = new CodexStateNormalizer();
  private readonly conversation = new CodexConversationNormalizer();
  private readonly environment: CodexEnvironmentNormalizer;
  private readonly contextWindow = new CodexContextWindowNormalizer();
  private readonly notification = new CodexNotificationEventNormalizer();
  private readonly adapter = new CodexAdapterFallbackNormalizer();

  constructor(modelDisplayName: (modelId: string) => string | undefined = () => undefined) {
    this.environment = new CodexEnvironmentNormalizer(modelDisplayName);
  }

  normalize(notification: CodexServerNotification): NormalizedNotification {
    const params = notification.params ?? {};
    const threadId = str(params.threadId) ?? str(rec(params.thread)?.id);
    const turnId = str(params.turnId) ?? str(rec(params.turn)?.id) ?? this.state.currentTurnId();
    const input: CodexNormalizationInput = {
      method: notification.method,
      params,
      threadId,
      turnId,
    };

    // Ordering is observable: state boundaries precede conversation rows;
    // environment changes precede context invalidation on model reroutes.
    const state = this.state.normalize(input);
    const conversation = this.conversation.normalize(input);
    const environment = this.environment.normalize(input);
    const contextWindow = this.contextWindow.normalize(input);
    const notice = this.notification.normalize(input);
    const events: AgentEvent[] = [
      ...state.events,
      ...conversation.events,
      ...environment.events,
      ...contextWindow.events,
      ...notice.events,
    ];
    const claimed =
      state.handled || conversation.handled || environment.handled || contextWindow.handled || notice.handled;
    events.push(...this.adapter.normalize(input, claimed));

    const result: NormalizedNotification = {
      events,
      threadId,
      turnId: state.turnId ?? turnId,
    };
    if (state.userMessageClientId !== undefined) {
      result.userMessageClientId = state.userMessageClientId;
    }
    return result;
  }
}
