import type { AgentEvent, AgentStructuredQuestion } from '@vibecook/puppeteer-core';
import { boundedHermesMapSet, hermesString } from './types.js';

const MAX_QUESTION_LENGTH = 4_096;
const MAX_OPTIONS = 128;
const MAX_OPTION_LENGTH = 1_024;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

/** Project the pinned Hermes clarify.request payload without parsing terminal text. */
export function hermesStructuredQuestions(payloadValue: unknown): AgentStructuredQuestion[] | undefined {
  const payload = record(payloadValue);
  const prompt = boundedText(payload?.question, MAX_QUESTION_LENGTH);
  if (!prompt) return undefined;
  const options = Array.isArray(payload?.choices)
    ? payload.choices.slice(0, MAX_OPTIONS).flatMap((choice) => {
        const label = boundedText(choice, MAX_OPTION_LENGTH);
        return label ? [{ label }] : [];
      })
    : [];
  const requestId = boundedText(payload?.request_id, MAX_OPTION_LENGTH);
  return [
    {
      ...(requestId ? { id: requestId } : {}),
      prompt,
      ...(options.length > 0 ? { options } : {}),
      allowMultiple: payload?.multi_select === true,
      // The native Hermes picker always offers an Other/free-text branch.
      allowFreeForm: true,
    },
  ];
}

/** Hermes approval/clarification frames → interaction state events. */
export class HermesInteractionNormalizer {
  private readonly questionStates = new Map<string, 'requested' | 'resolved'>();

  permission(payload: Record<string, unknown>, liveSessionId: string | undefined): AgentEvent[] {
    const toolCallId = hermesString(payload.tool_id);
    return [
      {
        type: 'interaction:permission-requested',
        requestId: toolCallId ?? liveSessionId ?? 'hermes-approval',
        ...(toolCallId ? { toolCallId } : {}),
        tool: hermesString(payload.name) ?? 'terminal',
        presentation: 'native-tui',
      },
    ];
  }

  requestQuestion(payload: Record<string, unknown>): AgentEvent[] {
    const requestId = hermesString(payload.request_id);
    const questions = hermesStructuredQuestions(payload);
    if (!requestId || !questions || this.questionStates.has(requestId)) return [];
    boundedHermesMapSet(this.questionStates, requestId, 'requested');
    return [{ type: 'interaction:question-requested', requestId, questions }];
  }

  expireQuestion(payload: Record<string, unknown>): AgentEvent[] {
    const requestId = hermesString(payload.request_id);
    if (!requestId || this.questionStates.get(requestId) === 'resolved') return [];
    boundedHermesMapSet(this.questionStates, requestId, 'resolved');
    return [{ type: 'interaction:question-resolved', requestId, outcome: 'cancelled' }];
  }
}
