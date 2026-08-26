import { randomUUID } from 'node:crypto';
import type { PromptReceipt, PromptSubmission } from '@vibecook/puppeteer-core';
import { OpenCodeHttpError, type OpenCodeClient, type OpenCodeModelSelection } from '../client.js';

export interface OpenCodePromptConfirmation {
  matched: boolean;
  turnId?: string;
  reason?: string;
}

interface PendingPromptConfirmation {
  promise: Promise<OpenCodePromptConfirmation>;
  cancel(reason: string): void;
}

/** Exact message-ID correlation gate for OpenCode prompt confirmation. */
export class OpenCodePromptConfirmationGate {
  private readonly pending = new Map<
    string,
    { resolve(result: OpenCodePromptConfirmation): void; timer: NodeJS.Timeout }
  >();

  expect(messageID: string, timeoutMs: number): PendingPromptConfirmation {
    if (this.pending.has(messageID)) throw new Error(`OpenCode prompt ${messageID} is already awaiting confirmation`);
    let settle!: (result: OpenCodePromptConfirmation) => void;
    const promise = new Promise<OpenCodePromptConfirmation>((resolve) => {
      settle = resolve;
    });
    const finish = (result: OpenCodePromptConfirmation): void => {
      const entry = this.pending.get(messageID);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(messageID);
      entry.resolve(result);
    };
    const timer = setTimeout(
      () => finish({ matched: false, reason: `no message.updated echo for ${messageID} within ${timeoutMs}ms` }),
      timeoutMs,
    );
    this.pending.set(messageID, { resolve: settle, timer });
    return { promise, cancel: (reason) => finish({ matched: false, reason }) };
  }

  confirm(messageID: string, turnId = messageID): boolean {
    const entry = this.pending.get(messageID);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(messageID);
    entry.resolve({ matched: true, turnId });
    return true;
  }

  rejectAll(reason: string): void {
    for (const [messageID, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(messageID);
      entry.resolve({ matched: false, reason });
    }
  }
}

export interface OpenCodePromptServiceOptions {
  client: OpenCodeClient;
  sessionId(): string;
  agent(): string;
  model(): OpenCodeModelSelection | undefined;
  confirmationTimeoutMs?: number;
  isDisposed(): boolean;
}

/** Owns OpenCode prompt serialization, submission, and exact echo correlation. */
export class OpenCodePromptService {
  readonly confirmations = new OpenCodePromptConfirmationGate();
  private inFlight = false;

  constructor(private readonly options: OpenCodePromptServiceOptions) {}

  async submit(submission: PromptSubmission): Promise<PromptReceipt> {
    if (this.options.isDisposed()) return { status: 'rejected', reason: 'OpenCode session observation is disposed' };
    if (this.inFlight) {
      return { status: 'rejected', reason: 'another OpenCode prompt is awaiting exact message-ID echo' };
    }
    this.inFlight = true;
    const messageID = `msg_puppeteer_${randomUUID().replaceAll('-', '')}`;
    const expectation = this.confirmations.expect(
      messageID,
      submission.confirmationTimeoutMs ?? this.options.confirmationTimeoutMs ?? 10_000,
    );
    try {
      try {
        const model = this.options.model();
        await this.options.client.submitPrompt(this.options.sessionId(), {
          messageID,
          agent: this.options.agent(),
          ...(model ? { model } : {}),
          parts: [{ type: 'text', text: submission.text }],
        });
      } catch (error) {
        expectation.cancel('OpenCode prompt request did not complete');
        if (error instanceof OpenCodeHttpError && error.status >= 400 && error.status < 500) {
          return { status: 'rejected', reason: `OpenCode rejected the prompt with status ${error.status}` };
        }
        return {
          status: 'uncertain',
          reason: `OpenCode prompt acceptance could not be determined: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const confirmation = await expectation.promise;
      return confirmation.matched
        ? { status: 'confirmed', ...(confirmation.turnId ? { turnId: confirmation.turnId } : {}) }
        : { status: 'uncertain', reason: confirmation.reason ?? 'exact OpenCode prompt echo was not observed' };
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.confirmations.rejectAll('OpenCode session observation was disposed');
  }
}
