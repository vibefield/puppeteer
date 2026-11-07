import type { GrokObservedEvent, GrokObservedFactory } from './types.js';

/** Presence-only Grok thought chunks → reasoning lifecycle events. */
export class GrokReasoningNormalizer {
  private readonly activePrompts = new Set<string>();

  progress(promptId: string, observed: GrokObservedFactory): GrokObservedEvent {
    const type = this.activePrompts.has(promptId) ? 'reasoning:progress' : 'reasoning:started';
    this.activePrompts.add(promptId);
    return observed({ type, reasoningId: promptId }, promptId);
  }

  /** The prompts whose thought is still open. */
  openPrompts(): string[] {
    return [...this.activePrompts];
  }

  complete(promptId: string, observed: GrokObservedFactory): GrokObservedEvent[] {
    return this.activePrompts.delete(promptId)
      ? [observed({ type: 'reasoning:completed', reasoningId: promptId }, promptId)]
      : [];
  }
}
