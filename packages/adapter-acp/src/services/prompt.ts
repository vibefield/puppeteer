import type {
  AgentEvent,
  AgentEventConfidence,
  AgentEventSource,
  PromptReceipt,
  PromptSubmission,
} from '@vibecook/puppeteer-core';
import type { PromptResponse } from '@agentclientprotocol/sdk';

export interface AcpPromptServiceOptions {
  sessionId(): string;
  request(params: {
    sessionId: string;
    prompt: [{ type: 'text'; text: string }];
  }): PromptResponse | PromiseLike<PromptResponse>;
  completeReasoning(): { active: boolean; reasoningId?: string };
  settleElicitations(outcome: 'failed' | 'superseded', nativeEvent: unknown): void;
  publish(event: AgentEvent, source: AgentEventSource, nativeEvent?: unknown, confidence?: AgentEventConfidence): void;
}

/** Owns ACP prompt correlation, turn framing, and assistant-message sealing. */
export class AcpPromptService {
  private turnCounter = 0;
  private turnId: string | undefined;
  private assistantText = '';

  constructor(private readonly options: AcpPromptServiceOptions) {}

  currentTurnId(): string | undefined {
    return this.turnId;
  }

  observe(event: AgentEvent): void {
    if (event.type === 'conversation:assistant-message') this.assistantText = event.text;
  }

  sealReplayedAssistant(nativeEvent: unknown): void {
    if (!this.assistantText) return;
    this.options.publish(
      { type: 'conversation:assistant-message', text: this.assistantText, final: true, displayOnly: false },
      'native-protocol',
      nativeEvent,
      'derived',
    );
    this.assistantText = '';
  }

  submit(submission: PromptSubmission): Promise<PromptReceipt> {
    const turnId = `acp-turn-${++this.turnCounter}`;
    this.turnId = turnId;
    this.assistantText = '';
    this.options.publish({ type: 'turn:started', turnId, prompt: submission.text }, 'native-hook');

    void Promise.resolve(
      this.options.request({ sessionId: this.options.sessionId(), prompt: [{ type: 'text', text: submission.text }] }),
    )
      .then((response) => {
        this.closeReasoning(response);
        this.options.settleElicitations('superseded', response);
        this.options.publish(
          {
            type: 'turn:completed',
            turnId,
            stopReason: response.stopReason,
            lastAssistantMessage: this.assistantText || undefined,
          },
          'native-hook',
          response,
        );
      })
      .catch((error: unknown) => {
        this.closeReasoning();
        this.options.settleElicitations('failed', { method: 'session/prompt', outcome: 'failed' });
        this.options.publish(
          { type: 'turn:failed', turnId, error: error instanceof Error ? error.message : String(error) },
          'native-hook',
        );
      });
    return Promise.resolve({ status: 'confirmed', turnId });
  }

  closeReasoning(nativeEvent?: unknown): void {
    const reasoning = this.options.completeReasoning();
    if (!reasoning.active) return;
    this.options.publish(
      { type: 'reasoning:completed', reasoningId: reasoning.reasoningId },
      'native-hook',
      nativeEvent,
      'derived',
    );
  }
}
