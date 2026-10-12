import type { AgentEvent, AgentStructuredQuestion } from '@vibefield/puppeteer-core';
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk';
import { acpElicitationQuestions } from '../normalization/interaction.js';

export interface AcpElicitationRequest {
  interactionId: string;
  request: CreateElicitationRequest;
  questions: AgentStructuredQuestion[];
}

export interface AcpElicitationServiceOptions {
  respond?:
    ((request: AcpElicitationRequest) => CreateElicitationResponse | Promise<CreateElicitationResponse>) | undefined;
  publish(event: AgentEvent, nativeEvent: unknown): void;
}

/** ACP form/URL elicitation lifecycle → normalized question events + response. */
export class AcpElicitationService {
  private counter = 0;
  private readonly urlInteractions = new Map<string, string>();

  constructor(private readonly options: AcpElicitationServiceOptions) {}

  async handle(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const nativeId =
      params.mode === 'url' && 'elicitationId' in params && typeof params.elicitationId === 'string'
        ? params.elicitationId
        : '';
    const interactionId = nativeId ? `acp-elicitation:${nativeId}` : `acp-elicitation-${++this.counter}`;
    if (nativeId) this.urlInteractions.set(nativeId, interactionId);
    const questions = acpElicitationQuestions(params);
    this.options.publish({ type: 'interaction:question-requested', requestId: interactionId, questions }, params);

    try {
      const response = this.options.respond
        ? await this.options.respond({ interactionId, request: params, questions })
        : ({ action: 'decline' } as const);
      if (response.action === 'accept') {
        if (params.mode !== 'url') {
          this.options.publish(
            { type: 'interaction:question-resolved', requestId: interactionId, outcome: 'answered' },
            { request: params, response },
          );
        }
      } else if (response.action === 'decline' || response.action === 'cancel') {
        if (nativeId) this.urlInteractions.delete(nativeId);
        this.options.publish(
          { type: 'interaction:question-resolved', requestId: interactionId, outcome: 'cancelled' },
          { request: params, response },
        );
      } else {
        if (nativeId) this.urlInteractions.delete(nativeId);
        this.options.publish(
          { type: 'interaction:question-resolved', requestId: interactionId, outcome: 'failed' },
          { request: params, response },
        );
      }
      return response;
    } catch (error) {
      if (nativeId) this.urlInteractions.delete(nativeId);
      this.options.publish(
        { type: 'interaction:question-resolved', requestId: interactionId, outcome: 'failed' },
        params,
      );
      throw error;
    }
  }

  complete(elicitationId: string, nativeEvent: unknown): void {
    const interactionId = this.urlInteractions.get(elicitationId);
    if (!interactionId) return;
    this.urlInteractions.delete(elicitationId);
    this.options.publish(
      { type: 'interaction:question-resolved', requestId: interactionId, outcome: 'answered' },
      nativeEvent,
    );
  }

  settlePending(outcome: 'failed' | 'superseded', nativeEvent: unknown): void {
    for (const interactionId of this.urlInteractions.values()) {
      this.options.publish({ type: 'interaction:question-resolved', requestId: interactionId, outcome }, nativeEvent);
    }
    this.urlInteractions.clear();
  }
}
