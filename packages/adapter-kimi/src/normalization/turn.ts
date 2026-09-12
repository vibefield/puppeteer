import type { AgentEvent } from '@vibecook/puppeteer-core';
import { MAX_KIMI_CORRELATIONS, boundedKimiSetAdd, kimiInputText, kimiOriginKind, kimiNativeTurnId } from './types.js';

interface PendingPrompt {
  text?: string | undefined;
  origin?: string | undefined;
}

/** Owns Kimi prompt/turn correlation and immutable terminal tombstones. */
export class KimiTurnNormalizer {
  private readonly pendingPrompts: PendingPrompt[] = [];
  private readonly startedTurns = new Set<string>();
  private readonly terminalTurns = new Set<string>();
  private activeTurnId: string | undefined;

  currentTurnId(): string | undefined {
    return this.activeTurnId;
  }

  resolveTurnId(value: unknown): string | undefined {
    return kimiNativeTurnId(value) ?? this.activeTurnId;
  }

  bufferPrompt(body: Record<string, unknown>): void {
    this.pendingPrompts.push({ text: kimiInputText(body.input), origin: kimiOriginKind(body.origin) });
    if (this.pendingPrompts.length > MAX_KIMI_CORRELATIONS) this.pendingPrompts.shift();
  }

  beginStep(turnId: string): { events: AgentEvent[]; restarted: boolean } {
    let restarted = false;
    if (this.terminalTurns.has(turnId) && this.pendingPrompts.length > 0) {
      this.terminalTurns.delete(turnId);
      this.startedTurns.delete(turnId);
      restarted = true;
    }
    return { events: this.startIfNeeded(turnId), restarted };
  }

  startIfNeeded(turnId: string): AgentEvent[] {
    this.activeTurnId = turnId;
    if (this.startedTurns.has(turnId)) return [];
    boundedKimiSetAdd(this.startedTurns, turnId);
    const prompt = this.pendingPrompts.shift();
    return [{ type: 'turn:started', turnId, ...(prompt?.text ? { prompt: prompt.text } : {}) }];
  }

  isTerminal(turnId: string): boolean {
    return this.terminalTurns.has(turnId);
  }

  settle(turnId: string): boolean {
    if (this.terminalTurns.has(turnId)) return false;
    boundedKimiSetAdd(this.terminalTurns, turnId);
    if (this.activeTurnId === turnId) this.activeTurnId = undefined;
    return true;
  }

  completed(turnId: string, stopReason: string, lastAssistantMessage?: string): AgentEvent {
    return {
      type: 'turn:completed',
      turnId,
      stopReason,
      ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
    };
  }

  failed(turnId: string, error?: string): AgentEvent {
    return { type: 'turn:failed', turnId, error };
  }
}
