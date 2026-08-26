import type { AgentEvent } from '@vibecook/puppeteer-core';
import { hermesStructuredQuestions } from '../questions.js';
import { boundedHermesMapSet, hermesString } from './types.js';

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
