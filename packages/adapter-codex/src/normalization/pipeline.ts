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
import { CodexModelNormalizer } from './model.js';
import { CodexNotificationEventNormalizer } from './notification.js';
import { CodexReasoningNormalizer } from './reasoning.js';
import { CodexSessionNormalizer } from './session.js';
import { CodexToolNormalizer } from './tool.js';
import { CodexTurnNormalizer } from './turn.js';
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
  private readonly session = new CodexSessionNormalizer();
  private readonly turn = new CodexTurnNormalizer();
  private readonly reasoning = new CodexReasoningNormalizer();
  private readonly tool = new CodexToolNormalizer();
  private readonly conversation = new CodexConversationNormalizer();
  private readonly environment = new CodexEnvironmentNormalizer();
  private readonly model: CodexModelNormalizer;
  private readonly contextWindow = new CodexContextWindowNormalizer();
  private readonly notification = new CodexNotificationEventNormalizer();
  private readonly adapter = new CodexAdapterFallbackNormalizer();

  constructor(modelDisplayName: (modelId: string) => string | undefined = () => undefined) {
    this.model = new CodexModelNormalizer(modelDisplayName);
  }

  normalize(notification: CodexServerNotification): NormalizedNotification {
    const params = notification.params ?? {};
    const threadId = str(params.threadId) ?? str(rec(params.thread)?.id);
    const turnId = str(params.turnId) ?? str(rec(params.turn)?.id) ?? this.turn.currentTurnId();
    const input: CodexNormalizationInput = {
      method: notification.method,
      params,
      threadId,
      turnId,
    };

    // Ordering is observable: state boundaries precede conversation rows;
    // environment changes precede context invalidation on model reroutes.
    const session = this.session.normalize(input);
    const turn = this.turn.normalize(input);
    const reasoning = this.reasoning.normalize(input);
    const tool = this.tool.normalize(input);
    const conversation = this.conversation.normalize(input);
    const environment = this.environment.normalize(input);
    const model = this.model.normalize(input);
    const contextWindow = this.contextWindow.normalize(input);
    const notice = this.notification.normalize(input);
    const events: AgentEvent[] = [
      ...session.events,
      ...turn.events,
      ...reasoning.events,
      ...tool.events,
      ...conversation.events,
      ...environment.events,
      ...model.events,
      ...contextWindow.events,
      ...notice.events,
    ];
    const claimed =
      session.handled ||
      turn.handled ||
      reasoning.handled ||
      tool.handled ||
      conversation.handled ||
      environment.handled ||
      model.handled ||
      contextWindow.handled ||
      notice.handled;
    events.push(...this.adapter.normalize(input, claimed));

    const result: NormalizedNotification = {
      events,
      threadId,
      turnId: turn.turnId ?? turnId,
    };
    if (turn.userMessageClientId !== undefined) {
      result.userMessageClientId = turn.userMessageClientId;
    }
    return result;
  }
}
