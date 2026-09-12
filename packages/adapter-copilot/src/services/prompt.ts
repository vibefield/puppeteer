import type { AgentHost, PromptReceipt, PromptSubmission } from '@vibecook/puppeteer-core';
import type { CopilotSessionObserver } from '../observation/session-observer.js';
export class CopilotPromptService {
  private inFlight = false;
  constructor(
    private readonly options: {
      host: AgentHost;
      runtimeSessionId: string;
      observer: CopilotSessionObserver;
      confirmationTimeoutMs?: number | undefined;
      isDisposed(): boolean;
    },
  ) {}
  async submit(submission: PromptSubmission): Promise<PromptReceipt> {
    if (this.options.isDisposed()) return { status: 'rejected', reason: 'Copilot session observation is disposed' };
    if (this.inFlight) return { status: 'rejected', reason: 'another Copilot prompt submission is awaiting echo' };
    if (submission.mode === 'paste-only') {
      const staged = await this.options.host.automateTerminal(this.options.runtimeSessionId, {
        kind: 'paste',
        text: submission.text,
        submit: false,
      });
      return staged.accepted
        ? { status: 'uncertain', reason: 'prompt text was staged but not submitted' }
        : { status: 'rejected', reason: staged.reason };
    }
    this.inFlight = true;
    const expected = this.options.observer.expectPrompt(
      submission.text,
      submission.confirmationTimeoutMs ?? this.options.confirmationTimeoutMs ?? 10_000,
    );
    try {
      const submitted = await this.options.host.automateTerminal(this.options.runtimeSessionId, {
        kind: 'paste',
        text: submission.text,
        submit: true,
      });
      if (!submitted.accepted) {
        expected.cancel();
        return { status: 'rejected', reason: submitted.reason };
      }
      void this.options.observer.poll();
      const result = await expected.promise;
      return result.matched ? { status: 'confirmed' } : { status: 'uncertain', reason: result.reason };
    } finally {
      this.inFlight = false;
    }
  }
}
