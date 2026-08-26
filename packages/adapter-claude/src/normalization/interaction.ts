import type { AgentStructuredQuestion } from '@vibecook/puppeteer-core';
import { claudeBoolean, claudeRecord, claudeString, nonEmptyClaudeString } from './wire.js';

/** Claude AskUserQuestion input → normalized structured questions. */
export function parseClaudeStructuredQuestions(input: unknown): AgentStructuredQuestion[] | undefined {
  const root = claudeRecord(input);
  if (!root || !Array.isArray(root.questions)) return undefined;
  const rootFreeForm = claudeBoolean(root.allowFreeForm) ?? claudeBoolean(root.allow_free_form);
  const parsed: AgentStructuredQuestion[] = [];
  for (const value of root.questions) {
    const question = claudeRecord(value);
    const prompt = nonEmptyClaudeString(question?.question) ?? nonEmptyClaudeString(question?.prompt);
    if (!question || !prompt) continue;
    const options = Array.isArray(question.options)
      ? (question.options.flatMap((option) => {
          const candidate = claudeRecord(option);
          const label = nonEmptyClaudeString(candidate?.label);
          if (!candidate || !label) return [];
          const description = claudeString(candidate.description);
          return [{ label, ...(description !== undefined ? { description } : {}) }];
        }) satisfies NonNullable<AgentStructuredQuestion['options']>)
      : undefined;
    const id = nonEmptyClaudeString(question.id);
    const header = claudeString(question.header);
    parsed.push({
      ...(id ? { id } : {}),
      ...(header !== undefined ? { header } : {}),
      prompt,
      ...(options ? { options } : {}),
      allowMultiple: claudeBoolean(question.multiSelect) ?? claudeBoolean(question.multi_select) ?? false,
      allowFreeForm:
        claudeBoolean(question.allowFreeForm) ?? claudeBoolean(question.allow_free_form) ?? rootFreeForm ?? true,
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

export function claudeQuestionOutcome(value: unknown): 'answered' | 'cancelled' {
  const body = claudeRecord(value);
  return body?.cancelled === true || body?.canceled === true ? 'cancelled' : 'answered';
}

export function normalizeClaudeQuestionRequested(requestId: string, questions: AgentStructuredQuestion[]) {
  return { type: 'question.requested' as const, requestId, questions };
}

export function normalizeClaudeQuestionResolved(
  requestId: string,
  outcome: 'answered' | 'failed' | 'cancelled' | 'superseded',
) {
  return { type: 'question.resolved' as const, requestId, outcome };
}

export function normalizeClaudePermissionRequested(
  requestId: string,
  tool: string,
  input: unknown,
  toolCallId?: string,
) {
  return {
    type: 'permission.requested' as const,
    requestId,
    ...(toolCallId ? { toolCallId } : {}),
    tool,
    input,
    presentation: 'native-tui' as const,
  };
}

export function normalizeClaudePermissionResolved(
  requestId: string,
  outcome: 'allowed' | 'denied' | 'dismissed' | 'unknown',
) {
  return { type: 'permission.resolved' as const, requestId, outcome };
}
