import type { ModelUpdatedEvent } from '@vibecook/puppeteer-core';
import { claudeOtelActor, type ClaudeOtelActorAttribution } from './actor.js';
import { claudeOtelEventTimestamp, otelString, type ClaudeOtelLogRecord } from './wire.js';

export interface ClaudeOtelModelObservation extends ClaudeOtelActorAttribution {
  event: ModelUpdatedEvent;
  timestamp: string;
}

export function normalizeClaudeOtelModel(record: ClaudeOtelLogRecord): ClaudeOtelModelObservation | undefined {
  if (otelString(record, 'event.name') !== 'api_request' && record.body !== 'claude_code.api_request') return undefined;
  const model = otelString(record, 'model');
  if (!model) return undefined;
  const actor = claudeOtelActor(record);
  return {
    event: { type: 'model:updated', intent: 'observed', model: { id: model, provider: 'anthropic' } },
    timestamp: claudeOtelEventTimestamp(record),
    ...actor,
  };
}
