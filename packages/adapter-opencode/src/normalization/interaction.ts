import type { AgentEvent } from '@vibefield/puppeteer-core';
import type { OpenCodeSseRecord } from '../transport/event-stream.js';
import { openCodeStructuredQuestions } from './monitor.js';
import { boundedOpenCodeMapSet, isOpenCodeRecord, openCodeText } from './wire.js';

export interface OpenCodeInteractionResult {
  event: AgentEvent;
  messageId?: string | undefined;
}

/** OpenCode permission/question records → interaction state events. */
export class OpenCodeInteractionNormalizer {
  private readonly permissions = new Map<string, 'requested' | 'resolved'>();
  private readonly questions = new Map<string, 'requested' | 'resolved'>();

  constructor(private readonly maximum: number) {}

  permissionAsked(record: OpenCodeSseRecord): OpenCodeInteractionResult | undefined {
    const requestId = openCodeText(record.properties.id);
    if (!requestId || this.permissions.has(requestId)) return undefined;
    boundedOpenCodeMapSet(this.permissions, requestId, 'requested', this.maximum);
    const tool = isOpenCodeRecord(record.properties.tool) ? record.properties.tool : undefined;
    const toolCallId = openCodeText(tool?.callID);
    const permission = openCodeText(record.properties.permission);
    return {
      event: {
        type: 'interaction:permission-requested',
        requestId,
        ...(toolCallId ? { toolCallId } : {}),
        ...(permission ? { tool: permission } : {}),
        input: {
          patterns: record.properties.patterns,
          metadata: record.properties.metadata,
          always: record.properties.always,
        },
        presentation: 'native-tui',
      },
      messageId: openCodeText(tool?.messageID),
    };
  }

  permissionReplied(record: OpenCodeSseRecord): OpenCodeInteractionResult | undefined {
    const requestId = openCodeText(record.properties.requestID);
    if (!requestId || this.permissions.get(requestId) === 'resolved') return undefined;
    boundedOpenCodeMapSet(this.permissions, requestId, 'resolved', this.maximum);
    const reply = openCodeText(record.properties.reply);
    const outcome = reply === 'once' || reply === 'always' ? 'allowed' : reply === 'reject' ? 'denied' : 'unknown';
    return { event: { type: 'interaction:permission-resolved', requestId, outcome } };
  }

  questionAsked(record: OpenCodeSseRecord): OpenCodeInteractionResult | undefined {
    const requestId = openCodeText(record.properties.id);
    const questions = openCodeStructuredQuestions(record.properties.questions);
    if (!requestId || !questions || this.questions.has(requestId)) return undefined;
    boundedOpenCodeMapSet(this.questions, requestId, 'requested', this.maximum);
    const tool = isOpenCodeRecord(record.properties.tool) ? record.properties.tool : undefined;
    return {
      event: { type: 'interaction:question-requested', requestId, questions },
      messageId: openCodeText(tool?.messageID),
    };
  }

  questionResolved(record: OpenCodeSseRecord): OpenCodeInteractionResult | undefined {
    const requestId = openCodeText(record.properties.requestID);
    if (!requestId || this.questions.get(requestId) === 'resolved') return undefined;
    boundedOpenCodeMapSet(this.questions, requestId, 'resolved', this.maximum);
    return {
      event: {
        type: 'interaction:question-resolved',
        requestId,
        outcome: record.type === 'question.replied' ? 'answered' : 'cancelled',
      },
    };
  }
}
