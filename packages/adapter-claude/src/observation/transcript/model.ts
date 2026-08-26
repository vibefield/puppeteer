import type { SemanticObservationEvent } from '../semantic-provider.js';
import { safeTranscriptEvidence, transcriptString, type ClaudeTranscriptRecord } from './wire.js';

export function projectClaudeTranscriptModel(record: ClaudeTranscriptRecord): SemanticObservationEvent | undefined {
  if (record.type !== 'assistant' && record.message?.role !== 'assistant') return undefined;
  const model = transcriptString(record.message?.model);
  if (!model) return undefined;
  return {
    event: { type: 'model:updated', intent: 'observed', model: { id: model, provider: 'anthropic' } },
    timestamp: record.timestamp,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.agentType ? { agentType: record.agentType } : {}),
    nativeEvent: safeTranscriptEvidence(record),
  };
}
