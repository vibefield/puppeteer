import type { TaskUpdatedEvent } from '@vibecook/puppeteer-core';
import type { RecentToolRequest } from './types.js';
import { claudeRecord, claudeString, nonEmptyClaudeString } from './wire.js';

function normalizedStatus(value: string | undefined): TaskUpdatedEvent['status'] {
  switch (value?.toLowerCase().replaceAll('_', '-')) {
    case 'proposed':
      return 'proposed';
    case 'pending':
    case 'open':
      return 'pending';
    case 'in-progress':
    case 'active':
    case 'working':
      return 'in-progress';
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'removed':
    case 'deleted':
      return 'removed';
    default:
      return 'unknown';
  }
}

export function parseClaudeTask(toolName: string, input: unknown): RecentToolRequest['task'] {
  const name = toolName.toLowerCase();
  if (name !== 'taskcreate' && name !== 'taskupdate') return undefined;
  const body = claudeRecord(input);
  if (!body) return undefined;
  const providerStatus = claudeString(body.status);
  const taskId =
    nonEmptyClaudeString(body.task_id) ?? nonEmptyClaudeString(body.taskId) ?? nonEmptyClaudeString(body.id);
  const description =
    claudeString(body.description) ??
    claudeString(body.task_description) ??
    claudeString(body.subject) ??
    claudeString(body.task_subject);
  return {
    taskId: taskId ?? '',
    ...(description !== undefined ? { description } : {}),
    status: name === 'taskcreate' ? 'pending' : normalizedStatus(providerStatus),
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(claudeString(body.team_name) !== undefined ? { teamName: claudeString(body.team_name) } : {}),
    ...(claudeString(body.teammate_name) !== undefined ? { teammateName: claudeString(body.teammate_name) } : {}),
  };
}

export function claudeTaskIdFromResponse(value: unknown): string | undefined {
  const body = claudeRecord(value);
  const structured =
    nonEmptyClaudeString(body?.task_id) ??
    nonEmptyClaudeString(body?.taskId) ??
    nonEmptyClaudeString(body?.id) ??
    nonEmptyClaudeString(claudeRecord(body?.task)?.id);
  if (structured) return structured;
  const text = claudeString(value) ?? claudeString(body?.content) ?? claudeString(body?.message);
  return text?.match(/\btask\s+#?([\w.-]+)\b/i)?.[1];
}

export function normalizeClaudeTaskUpdated(fields: Omit<TaskUpdatedEvent, 'type'>): TaskUpdatedEvent {
  return { type: 'task.updated', ...fields };
}
