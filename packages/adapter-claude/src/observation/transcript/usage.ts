import type { TokensUsedEvent } from '@vibecook/puppeteer-core';
import type { SemanticObservationEvent } from '../semantic-provider.js';
import {
  safeTranscriptEvidence,
  transcriptNonNegativeNumber,
  transcriptObject,
  transcriptRecordId,
  transcriptString,
  type ClaudeTranscriptRecord,
} from './wire.js';

export function claudeTranscriptUsageId(record: ClaudeTranscriptRecord): string {
  return `claude-request:${record.requestId ?? transcriptString(record.message?.id) ?? transcriptRecordId(record)}`;
}

export function projectClaudeTranscriptUsage(record: ClaudeTranscriptRecord): SemanticObservationEvent | undefined {
  if (record.type !== 'assistant' && record.message?.role !== 'assistant') return undefined;
  const usage = transcriptObject(record.message?.usage);
  if (!usage) return undefined;
  const inputTokens = transcriptNonNegativeNumber(usage.input_tokens);
  const outputTokens = transcriptNonNegativeNumber(usage.output_tokens);
  const cacheReadTokens = transcriptNonNegativeNumber(usage.cache_read_input_tokens ?? usage.cache_read_tokens);
  const cacheCreationTokens = transcriptNonNegativeNumber(
    usage.cache_creation_input_tokens ?? usage.cache_creation_tokens,
  );
  const buckets = [inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens];
  if (buckets.every((value) => value === undefined)) return undefined;
  const costUsd = transcriptNonNegativeNumber(usage.cost_usd);
  const event: TokensUsedEvent = {
    type: 'tokens.used',
    usageId: claudeTranscriptUsageId(record),
    boundary: 'response',
    canonical: true,
    totalTokens: buckets.reduce<number>((total, value) => total + (value ?? 0), 0),
    meterTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    ...(costUsd === undefined ? {} : { costUsd }),
    breakdown: {
      ...(inputTokens === undefined ? {} : { inputTokens, freshInputTokens: inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
    },
  };
  return {
    event,
    timestamp: record.timestamp,
    ...(record.promptId ? { promptId: record.promptId } : {}),
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.agentType ? { agentType: record.agentType } : {}),
    nativeEvent: safeTranscriptEvidence(record),
  };
}
