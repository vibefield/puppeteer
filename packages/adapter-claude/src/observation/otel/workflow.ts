import type { WorkflowUpdatedEvent } from '@vibecook/puppeteer-core';
import { claudeOtelEventTimestamp, otelString, type ClaudeOtelLogRecord } from './wire.js';

export interface ClaudeOtelWorkflowObservation {
  event: WorkflowUpdatedEvent;
  timestamp: string;
}

/** OTel identifies an observed run and name, without worker membership or completion. */
export function normalizeClaudeOtelWorkflow(record: ClaudeOtelLogRecord): ClaudeOtelWorkflowObservation | undefined {
  const workflowId = otelString(record, 'workflow.run_id');
  if (!workflowId) return undefined;
  const name = otelString(record, 'workflow.name');
  return {
    event: { type: 'workflow:updated', workflowId, active: true, ...(name ? { name } : {}) },
    timestamp: claudeOtelEventTimestamp(record),
  };
}
