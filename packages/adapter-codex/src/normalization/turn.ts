import type { TurnEvent } from '@vibecook/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, itemText, rec, str } from './types.js';

export interface CodexTurnNormalization extends CategoryNormalization<TurnEvent> {
  turnId?: string | undefined;
  userMessageClientId?: string | null;
}

/** Codex turn boundaries and deferred prompt correlation -> Core turn events. */
export class CodexTurnNormalizer {
  private pendingTurn: { turnId?: string | undefined; emitted: boolean } | undefined;

  currentTurnId(): string | undefined {
    return this.pendingTurn?.turnId;
  }

  normalize(input: CodexNormalizationInput): CodexTurnNormalization {
    const events: TurnEvent[] = [];
    const result: CodexTurnNormalization = { handled: false, events };
    const { method, params } = input;

    const flushStarted = (prompt?: string): void => {
      if (!this.pendingTurn || this.pendingTurn.emitted) return;
      events.push({ type: 'turn:started', turnId: this.pendingTurn.turnId, prompt });
      this.pendingTurn.emitted = true;
    };

    if (method === 'item/started' || method === 'item/completed') {
      const item = rec(params.item);
      if (!item || str(item.type) !== 'userMessage') return result;
      result.handled = true;
      if (method === 'item/completed') {
        result.userMessageClientId = str(item.clientId) ?? null;
        flushStarted(itemText(item));
      }
      return result;
    }

    if (method === 'turn/started') {
      result.handled = true;
      this.pendingTurn = { turnId: str(rec(params.turn)?.id), emitted: false };
      result.turnId = this.pendingTurn.turnId;
      return result;
    }

    if (method === 'turn/completed') {
      result.handled = true;
      const turn = rec(params.turn);
      const turnId = str(turn?.id) ?? this.pendingTurn?.turnId;
      flushStarted();
      const status = str(turn?.status);
      const nativeError = turn?.error;
      if (status === 'failed' || (nativeError !== null && nativeError !== undefined)) {
        const error = typeof nativeError === 'string' ? nativeError : str(rec(nativeError)?.message);
        events.push({ type: 'turn:failed', turnId, error });
      } else {
        events.push({ type: 'turn:completed', turnId });
      }
      this.pendingTurn = undefined;
    }
    return result;
  }
}
