import type { AgentEvent, AgentStructuredQuestion } from '@vibefield/puppeteer-core';
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

function structuredQuestion(payload: Record<string, unknown> | undefined, id: unknown) {
  const prompt = boundedText(payload?.question, MAX_QUESTION_LENGTH);
  if (!prompt) return undefined;
  const options = Array.isArray(payload?.choices)
    ? payload.choices.slice(0, MAX_OPTIONS).flatMap((choice) => {
        const label = boundedText(choice, MAX_OPTION_LENGTH);
        return label ? [{ label }] : [];
      })
    : [];
  const questionId = boundedText(id, MAX_OPTION_LENGTH);
  return {
    ...(questionId ? { id: questionId } : {}),
    prompt,
    ...(options.length > 0 ? { options } : {}),
    allowMultiple: payload?.multi_select === true,
    // The native Hermes picker always offers an Other/free-text branch.
    allowFreeForm: true,
  } satisfies AgentStructuredQuestion;
}

/**
 * Project a Hermes clarification without parsing terminal text: the 0.20 `clarify.request` event
 * payload (one question, `request_id`) or the 0.21 `clarify` server-request params (one question,
 * or a batch of `questions` with their own `qid`s).
 */
export function hermesStructuredQuestions(payloadValue: unknown): AgentStructuredQuestion[] | undefined {
  const payload = record(payloadValue);
  if (Array.isArray(payload?.questions)) {
    const batch = payload.questions
      .slice(0, MAX_OPTIONS)
      .flatMap((entry) => structuredQuestion(record(entry), record(entry)?.qid) ?? []);
    return batch.length > 0 ? batch : undefined;
  }
  const single = structuredQuestion(payload, payload?.request_id);
  return single ? [single] : undefined;
}

/** Hermes approval/clarification frames → interaction state events. */
export class HermesInteractionNormalizer {
  private readonly questionStates = new Map<string, 'requested' | 'resolved'>();
  /** Open server→client requests by `srq-` id, so `request.cancel` resolves the interaction it opened. */
  private readonly serverRequests = new Map<string, { kind: 'permission' | 'question'; requestId: string }>();

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

  /**
   * The 0.21 `approval` server request. Its answer comes from the native TUI and never reaches this
   * observer, so the request opens the interaction and only a withdrawal (`request.cancel`) closes it.
   */
  requestPermission(serverRequestId: string, payload: Record<string, unknown>): AgentEvent[] {
    const requestId = hermesString(payload.request_id) ?? serverRequestId;
    if (this.serverRequests.has(serverRequestId)) return [];
    boundedHermesMapSet(this.serverRequests, serverRequestId, { kind: 'permission', requestId });
    return [
      {
        type: 'interaction:permission-requested',
        requestId,
        tool: hermesString(payload.tool_name) ?? 'terminal',
        presentation: 'native-tui',
      },
    ];
  }

  /** The 0.21 `clarify` server request; its params carry no request id, so the `srq-` id names it. */
  requestServerQuestion(serverRequestId: string, payload: Record<string, unknown>): AgentEvent[] {
    const questions = hermesStructuredQuestions({ ...payload, request_id: undefined });
    if (!questions || this.serverRequests.has(serverRequestId)) return [];
    boundedHermesMapSet(this.serverRequests, serverRequestId, { kind: 'question', requestId: serverRequestId });
    boundedHermesMapSet(this.questionStates, serverRequestId, 'requested');
    return [{ type: 'interaction:question-requested', requestId: serverRequestId, questions }];
  }

  /** `request.cancel {id, method, reason}`: a timeout, interrupt, or close withdrew an open request. */
  cancelServerRequest(payload: Record<string, unknown>): AgentEvent[] {
    const serverRequestId = hermesString(payload.id);
    const open = serverRequestId ? this.serverRequests.get(serverRequestId) : undefined;
    if (!serverRequestId || !open) return [];
    this.serverRequests.delete(serverRequestId);
    if (open.kind === 'permission') {
      return [{ type: 'interaction:permission-resolved', requestId: open.requestId, outcome: 'dismissed' }];
    }
    return this.expireQuestion({ request_id: open.requestId });
  }

  expireQuestion(payload: Record<string, unknown>): AgentEvent[] {
    const requestId = hermesString(payload.request_id);
    if (!requestId || this.questionStates.get(requestId) === 'resolved') return [];
    boundedHermesMapSet(this.questionStates, requestId, 'resolved');
    return [{ type: 'interaction:question-resolved', requestId, outcome: 'cancelled' }];
  }
}
