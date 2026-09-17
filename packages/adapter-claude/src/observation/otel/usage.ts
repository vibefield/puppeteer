import type { TokensUsedEvent } from '@vibecook/puppeteer-core';
import { claudeOtelActor, type ClaudeOtelActorAttribution } from './actor.js';
import { claudeOtelEventTimestamp, otelNonNegativeNumber, otelString, type ClaudeOtelLogRecord } from './wire.js';

export interface ClaudeOtelUsageObservation extends ClaudeOtelActorAttribution {
  event: TokensUsedEvent;
  timestamp: string;
  sessionId: string;
  promptId?: string;
  providerVersion?: string;
  /** Contains only the allow-listed attributes produced by `wire.ts`. */
  nativeEvent: ClaudeOtelLogRecord;
}

export function claudeRequestUsageId(record: ClaudeOtelLogRecord): string {
  const identity =
    otelString(record, 'request_id') ??
    otelString(record, 'client_request_id') ??
    [
      otelString(record, 'session.id') ?? 'unknown-session',
      otelString(record, 'prompt.id') ?? 'unknown-prompt',
      String(record.attributes['event.sequence'] ?? record.timestamp),
    ].join(':');
  return `claude-request:${identity}`;
}

/** Normalize the one authoritative Claude request-completion log. */
export function normalizeClaudeOtelUsage(record: ClaudeOtelLogRecord): ClaudeOtelUsageObservation | undefined {
  if (otelString(record, 'event.name') !== 'api_request' && record.body !== 'claude_code.api_request') return undefined;
  const sessionId = otelString(record, 'session.id');
  if (!sessionId) return undefined;

  const inputTokens = otelNonNegativeNumber(record, 'input_tokens');
  const outputTokens = otelNonNegativeNumber(record, 'output_tokens');
  const cacheReadTokens = otelNonNegativeNumber(record, 'cache_read_tokens');
  const cacheCreationTokens = otelNonNegativeNumber(record, 'cache_creation_tokens');
  const costUsd = otelNonNegativeNumber(record, 'cost_usd');
  const buckets = [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens];
  const hasTokens = buckets.some((value) => value !== undefined);
  if (!hasTokens && costUsd === undefined) return undefined;

  const totalTokens = buckets.reduce<number>((total, value) => total + (value ?? 0), 0);
  const meterTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  const modelId = otelString(record, 'model');
  const speed = otelString(record, 'speed');
  const promptId = otelString(record, 'prompt.id');
  const actor = claudeOtelActor(record);

  return {
    event: {
      type: 'usage:tokens-used',
      usageId: claudeRequestUsageId(record),
      boundary: 'response',
      canonical: true,
      origin: 'telemetry',
      pricing: {
        providerId: 'anthropic',
        ...(modelId ? { modelId } : {}),
        ...(speed ? { serviceTier: speed } : {}),
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
        ...(inputTokens !== undefined && cacheReadTokens !== undefined && cacheCreationTokens !== undefined
          ? { contextTokens: inputTokens + cacheReadTokens + cacheCreationTokens }
          : {}),
      },
      ...(hasTokens ? { totalTokens, meterTokens } : {}),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(hasTokens
        ? {
            breakdown: {
              ...(inputTokens === undefined ? {} : { inputTokens, freshInputTokens: inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
              ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
              ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
            },
          }
        : {}),
    },
    timestamp: claudeOtelEventTimestamp(record),
    sessionId,
    ...(promptId ? { promptId } : {}),
    ...actor,
    ...(record.providerVersion ? { providerVersion: record.providerVersion } : {}),
    nativeEvent: record,
  };
}
