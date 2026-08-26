import type { AdapterEvent } from '@vibecook/puppeteer-core';
import { type CodexNormalizationInput, rec, str } from './types.js';

const AMBIENT = new Set<string>([
  'remoteControl/status/changed',
  'mcpServer/startupStatus/updated',
  'mcpServer/oauthLogin/completed',
  'account/rateLimits/updated',
  'account/updated',
  'account/login/completed',
  'thread/status/changed',
  'app/list/updated',
  'skills/changed',
]);

/** Retains unclaimed session evidence without inventing semantics. */
export class CodexAdapterFallbackNormalizer {
  normalize(input: CodexNormalizationInput, claimed: boolean): AdapterEvent[] {
    if (claimed || AMBIENT.has(input.method)) return [];

    if (input.method === 'item/started') return [];
    if (input.method === 'item/completed') {
      const itemType = str(rec(input.params.item)?.type) ?? 'unknown';
      return [{ type: 'adapter:native-event', adapter: 'codex', nativeType: `item/${itemType}` }];
    }

    return [{ type: 'adapter:native-event', adapter: 'codex', nativeType: input.method }];
  }
}
