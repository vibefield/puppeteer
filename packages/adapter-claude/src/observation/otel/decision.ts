import { claudeOtelEventTimestamp, otelString, type ClaudeOtelLogRecord } from './wire.js';

/** How a decision closes the permission it answers; `unknown` is never a decision's. */
export type ClaudeOtelDecisionOutcome = 'allowed' | 'denied' | 'dismissed';

export interface ClaudeOtelToolDecision {
  /** The hooks' `tool_use_id`: the one key that joins a decision to the request it answers. */
  toolUseId: string;
  outcome: ClaudeOtelDecisionOutcome;
  timestamp: string;
}

/** `decision` is `accept` or `reject`; a `user_abort` source is a prompt dismissed without an answer. */
function decisionOutcome(record: ClaudeOtelLogRecord): ClaudeOtelDecisionOutcome | undefined {
  const decision = otelString(record, 'decision');
  if (decision === 'accept') return 'allowed';
  if (decision === 'reject') return otelString(record, 'source') === 'user_abort' ? 'dismissed' : 'denied';
  return undefined;
}

/**
 * Claude logs `tool_decision` when a tool's permission is decided: the person's answer at the
 * prompt, a hook's or a rule's. No hook fires at that moment; `PostToolUse` comes only when the
 * approved tool ends (https://code.claude.com/docs/en/monitoring-usage#tool-decision-event).
 */
export function normalizeClaudeOtelToolDecision(record: ClaudeOtelLogRecord): ClaudeOtelToolDecision | undefined {
  if (otelString(record, 'event.name') !== 'tool_decision' && record.body !== 'claude_code.tool_decision') {
    return undefined;
  }
  const toolUseId = otelString(record, 'tool_use_id');
  const outcome = decisionOutcome(record);
  if (!toolUseId || !outcome) return undefined;
  return { toolUseId, outcome, timestamp: claudeOtelEventTimestamp(record) };
}
