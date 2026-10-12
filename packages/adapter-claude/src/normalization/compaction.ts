import type { CompactionCompletedEvent, CompactionStartedEvent } from '@vibefield/puppeteer-core';

export function normalizeClaudeCompactionStarted(compactionId: string, trigger?: string): CompactionStartedEvent {
  return { type: 'compaction:started', compactionId, trigger };
}

export function normalizeClaudeCompactionCompleted(
  compactionId: string,
  trigger: string | undefined,
  outcome: CompactionCompletedEvent['outcome'],
): CompactionCompletedEvent {
  return { type: 'compaction:completed', compactionId, trigger, outcome };
}
