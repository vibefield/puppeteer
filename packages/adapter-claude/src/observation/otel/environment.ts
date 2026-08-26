import type { SessionEnvironmentUpdatedEvent } from '@vibecook/puppeteer-core';
import { claudeOtelEventTimestamp, otelString, type ClaudeOtelLogRecord } from './wire.js';

export interface ClaudeOtelEnvironmentObservation {
  event: SessionEnvironmentUpdatedEvent;
  timestamp: string;
  agentId?: string;
  agentType?: string;
}

export function normalizeClaudeOtelEnvironment(
  record: ClaudeOtelLogRecord,
): ClaudeOtelEnvironmentObservation | undefined {
  if (otelString(record, 'event.name') !== 'api_request' && record.body !== 'claude_code.api_request') return undefined;
  const model = otelString(record, 'model');
  if (!model) return undefined;
  const agentId = otelString(record, 'agent.id') ?? otelString(record, 'agent_id');
  const agentType =
    otelString(record, 'agent.type') ?? otelString(record, 'agent.name') ?? otelString(record, 'agent_type');
  return {
    event: { type: 'session.environment.updated', intent: 'observed', model: { id: model, provider: 'anthropic' } },
    timestamp: claudeOtelEventTimestamp(record),
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
  };
}
