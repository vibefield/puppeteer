import type { GrokObservedEvent, GrokObservedFactory, GrokUpdate, GrokUpdateMeta, GrokUpdateRecord } from './types.js';
import { grokTextContent } from './types.js';

/** Owns Grok session/turn correlation and pending user-prompt materialization. */
export class GrokStateNormalizer {
  private readonly startedPrompts = new Set<string>();
  private readonly completedPrompts = new Set<string>();
  private activePrompt: string | undefined;
  private pendingPrompt: string | undefined;
  private pendingUser: { text: string; timestamp?: string; nativeEvent: unknown } | undefined;
  private fallbackPromptCounter = 0;

  normalizeHook(update: GrokUpdate, sessionId: string | undefined, observed: GrokObservedFactory): GrokObservedEvent[] {
    if (update.event_name === 'session_start') {
      return [observed({ type: 'session.started', nativeSessionId: sessionId }, undefined)];
    }
    if (update.event_name === 'user_prompt_submit' && typeof update.prompt_id === 'string') {
      this.pendingPrompt = update.prompt_id;
      this.activePrompt = update.prompt_id;
      return this.materializePendingUser(update.prompt_id);
    }
    if (update.event_name === 'session_end') {
      return [observed({ type: 'session.exited', reason: update.reason as string | undefined }, undefined)];
    }
    return [];
  }

  normalizeUser(
    update: GrokUpdate,
    meta: GrokUpdateMeta | undefined,
    timestamp: string | undefined,
    nativeEvent: unknown,
    observed: GrokObservedFactory,
  ): GrokObservedEvent[] {
    const promptId = this.promptId(update, meta);
    if (!promptId) {
      this.pendingUser = {
        text: (this.pendingUser?.text ?? '') + grokTextContent(update),
        timestamp: this.pendingUser?.timestamp ?? timestamp,
        nativeEvent,
      };
      return [];
    }
    this.activePrompt = promptId;
    this.pendingPrompt = undefined;
    if (this.startedPrompts.has(promptId)) return [];
    this.startedPrompts.add(promptId);
    return [observed({ type: 'turn.started', turnId: promptId, prompt: grokTextContent(update) }, promptId)];
  }

  promptId(update: GrokUpdate, meta: GrokUpdateMeta | undefined): string | undefined {
    return (
      (typeof update.prompt_id === 'string' ? update.prompt_id : undefined) ??
      (typeof meta?.promptId === 'string' ? meta.promptId : undefined) ??
      (typeof update._meta?.promptId === 'string' ? update._meta.promptId : undefined) ??
      this.pendingPrompt
    );
  }

  correlatedPromptId(update: GrokUpdate, meta: GrokUpdateMeta | undefined): string | undefined {
    return this.promptId(update, meta) ?? this.activePrompt;
  }

  setActive(promptId: string): void {
    this.activePrompt = promptId;
  }

  beginCompletion(update: GrokUpdate, meta: GrokUpdateMeta | undefined): string | undefined {
    const promptId = this.correlatedPromptId(update, meta) ?? this.newFallbackPromptId(update);
    if (this.completedPrompts.has(promptId)) return undefined;
    this.completedPrompts.add(promptId);
    return promptId;
  }

  finishCompletion(promptId: string): void {
    if (this.activePrompt === promptId) this.activePrompt = undefined;
  }

  completionEvent(promptId: string, stopReason: string | undefined, lastAssistantMessage: string | undefined) {
    return {
      type: 'turn.completed' as const,
      turnId: promptId,
      stopReason,
      lastAssistantMessage,
    };
  }

  materializePendingUser(promptId: string): GrokObservedEvent[] {
    const pending = this.pendingUser;
    if (!pending) return [];
    this.pendingUser = undefined;
    this.pendingPrompt = undefined;
    this.activePrompt = promptId;
    if (this.startedPrompts.has(promptId)) return [];
    this.startedPrompts.add(promptId);
    return [
      {
        event: { type: 'turn.started', turnId: promptId, prompt: pending.text },
        promptId,
        timestamp: pending.timestamp,
        source: 'native-transcript',
        confidence: 'authoritative',
        nativeEvent: pending.nativeEvent,
      },
    ];
  }

  private newFallbackPromptId(update: GrokUpdate): string {
    const index = update._meta?.promptIndex;
    return `grok-prompt-${typeof index === 'number' ? index + 1 : ++this.fallbackPromptCounter}`;
  }
}
