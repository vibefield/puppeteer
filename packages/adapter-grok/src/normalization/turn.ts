import type { GrokObservedEvent, GrokObservedFactory, GrokUpdate, GrokUpdateMeta } from './types.js';
import { grokTextContent } from './types.js';

/** Owns Grok turn correlation and pending user-prompt materialization. */
export class GrokTurnNormalizer {
  private readonly startedPrompts = new Set<string>();
  private readonly completedPrompts = new Set<string>();
  /** Turns only the replay's settle ended, until one shows live work. */
  private readonly settledPrompts = new Set<string>();
  /** Settled turns that showed live work, until their own end. */
  private readonly reopenedPrompts = new Set<string>();
  private activePrompt: string | undefined;
  private pendingPrompt: string | undefined;
  private pendingUser: { text: string; timestamp?: string | undefined; nativeEvent: unknown } | undefined;
  private fallbackPromptCounter = 0;

  normalizeHook(update: GrokUpdate): GrokObservedEvent[] {
    if (update.event_name === 'user_prompt_submit' && typeof update.prompt_id === 'string') {
      this.pendingPrompt = update.prompt_id;
      this.activePrompt = update.prompt_id;
      return this.materializePendingUser(update.prompt_id);
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
    return [observed({ type: 'turn:started', turnId: promptId, prompt: grokTextContent(update) }, promptId)];
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
    this.reopenedPrompts.delete(promptId);
  }

  completionEvent(promptId: string, stopReason: string | undefined, lastAssistantMessage: string | undefined) {
    return {
      type: 'turn:completed' as const,
      turnId: promptId,
      stopReason,
      ...(stopReason === 'cancelled' ? { outcome: 'interrupted' as const } : {}),
      lastAssistantMessage,
    };
  }

  /** Grok's only failure carrier: a `turn_completed` that names an `error_kind`, passed through verbatim. */
  failureEvent(promptId: string, errorKind: string) {
    return { type: 'turn:failed' as const, turnId: promptId, error: errorKind };
  }

  /**
   * The replay ended. Its open turns end here, so no prompt carries into the next live turn, and the log's own
   * `turn_completed` for one is a duplicate unless the turn shows live work first (`reopenSettled`). Newest first: the
   * session's active turn is the last one started.
   */
  settleReplay(): string[] {
    const open = [...this.startedPrompts].filter((promptId) => !this.completedPrompts.has(promptId)).reverse();
    for (const promptId of open) {
      this.completedPrompts.add(promptId);
      this.settledPrompts.add(promptId);
    }
    this.activePrompt = undefined;
    this.pendingPrompt = undefined;
    this.pendingUser = undefined;
    return open;
  }

  /**
   * A record of live work names this prompt. The leader outlives a pane, so a resume can come in mid-turn: a settled
   * turn that shows live work is still running, and its own `turn_completed` ends it. A bare one, with no live work
   * before it, stays the settle's duplicate, so a late end never reaches a newer turn. A reopened turn gets no second
   * `turn:started`: `isReopened` says it runs, from this record to its end, and the record's own events carry that.
   */
  reopenSettled(promptId: string): void {
    if (!this.settledPrompts.delete(promptId)) return;
    this.completedPrompts.delete(promptId);
    this.reopenedPrompts.add(promptId);
  }

  isReopened(promptId: string | undefined): boolean {
    return promptId !== undefined && this.reopenedPrompts.has(promptId);
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
        event: { type: 'turn:started', turnId: promptId, prompt: pending.text },
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
