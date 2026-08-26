import type { AgentEvent } from '@vibecook/puppeteer-core';
import { isOpenCodeRecord, openCodeNumber } from './wire.js';

/** OpenCode step-finish token facts → deduplicated context-window events. */
export class OpenCodeContextWindowNormalizer {
  private lastUsage: string | undefined;

  constructor(private readonly capacityTokens: number | undefined) {}

  normalize(part: Record<string, unknown>, modelId: string | undefined): AgentEvent[] {
    if (!this.capacityTokens) return [];
    const tokens = isOpenCodeRecord(part.tokens) ? part.tokens : undefined;
    const cache = isOpenCodeRecord(tokens?.cache) ? tokens.cache : undefined;
    const usedTokens =
      openCodeNumber(tokens?.total) ??
      [tokens?.input, tokens?.output, cache?.read, cache?.write].reduce<number>(
        (sum, candidate) => sum + (openCodeNumber(candidate) ?? 0),
        0,
      );
    const identity = `${usedTokens}/${this.capacityTokens}/${modelId ?? ''}`;
    if (identity === this.lastUsage) return [];
    this.lastUsage = identity;
    return [
      {
        type: 'context-window:updated',
        usedTokens,
        capacityTokens: this.capacityTokens,
        ...(modelId ? { modelId } : {}),
      },
    ];
  }
}

export function normalizeOpenCodeContextInvalidated(): AgentEvent {
  return { type: 'context-window:invalidated', reason: 'compacted' };
}
