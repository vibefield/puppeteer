import type { ReasoningEvent } from '@vibecook/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, rec, str } from './types.js';

/** Codex reasoning items and deltas -> Core reasoning events. */
export class CodexReasoningNormalizer {
  private readonly summaries = new Map<string, string>();

  normalize(input: CodexNormalizationInput): CategoryNormalization<ReasoningEvent> {
    const events: ReasoningEvent[] = [];
    const { method, params } = input;
    if (method === 'item/started' || method === 'item/completed') {
      const item = rec(params.item);
      if (!item || str(item.type) !== 'reasoning') return { handled: false, events };
      const itemId = str(item.id) ?? 'unknown-item';
      if (method === 'item/started') {
        events.push({ type: 'reasoning:started', reasoningId: itemId });
      } else {
        const summary = Array.isArray(item.summary)
          ? item.summary.filter((part): part is string => typeof part === 'string').join('\n\n')
          : undefined;
        if (summary && summary !== this.summaries.get(itemId)) {
          events.push({ type: 'reasoning:summary', reasoningId: itemId, text: summary, final: true });
        }
        this.summaries.delete(itemId);
        events.push({ type: 'reasoning:completed', reasoningId: itemId });
      }
      return { handled: true, events };
    }

    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryPartAdded') {
      events.push({ type: 'reasoning:progress', reasoningId: str(params.itemId) });
      return { handled: true, events };
    }
    if (method === 'item/reasoning/summaryTextDelta') {
      const itemId = str(params.itemId) ?? 'reasoning';
      const summary = (this.summaries.get(itemId) ?? '') + (str(params.delta) ?? '');
      this.summaries.set(itemId, summary);
      events.push({ type: 'reasoning:summary', reasoningId: itemId, text: summary, final: false });
      return { handled: true, events };
    }
    return { handled: false, events };
  }
}
