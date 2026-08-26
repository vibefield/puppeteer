import type { ContextWindowEvent } from '@vibecook/puppeteer-core';
import { type CategoryNormalization, type CodexNormalizationInput, num, rec } from './types.js';

/** Codex token-pressure and invalidation evidence for the context-window category. */
export class CodexContextWindowNormalizer {
  normalize(input: CodexNormalizationInput): CategoryNormalization<ContextWindowEvent> {
    const events: ContextWindowEvent[] = [];
    const { method, params } = input;

    if (method === 'item/started' || method === 'item/completed') {
      const item = rec(params.item);
      if (item?.type !== 'contextCompaction') return { handled: false, events };
      if (method === 'item/completed') {
        events.push({ type: 'context-window.invalidated', reason: 'compacted' });
      }
      return { handled: true, events };
    }

    switch (method) {
      case 'thread/tokenUsage/updated': {
        const usage = rec(params.tokenUsage);
        const last = rec(usage?.last);
        const usedTokens = num(last?.totalTokens);
        const capacityTokens = num(usage?.modelContextWindow);
        if (usedTokens !== undefined && capacityTokens !== undefined) {
          events.push({ type: 'context-window.updated', usedTokens, capacityTokens });
          return { handled: true, events };
        }
        if (usage && usage.modelContextWindow === null) {
          events.push({ type: 'context-window.invalidated', reason: 'provider-reset' });
          return { handled: true, events };
        }
        return { handled: false, events };
      }

      case 'thread/compacted':
        events.push({ type: 'context-window.invalidated', reason: 'compacted' });
        return { handled: true, events };

      case 'model/rerouted':
        events.push({ type: 'context-window.invalidated', reason: 'model-changed' });
        return { handled: true, events };

      default:
        return { handled: false, events };
    }
  }
}
