import type { AgentHost, PromptReceipt, PromptSubmission } from '@vibefield/puppeteer-core';
import type { KimiSessionObserver } from '../observation/session-observer.js';

export interface KimiPromptServiceOptions {
  host: AgentHost;
  runtimeSessionId: string;
  observer: KimiSessionObserver;
  confirmationTimeoutMs?: number | undefined;
  isDisposed(): boolean;
}

/** Owns Kimi TUI prompt injection and durable turn.prompt confirmation. */
export class KimiPromptService {
  private inFlight = false;

  constructor(private readonly options: KimiPromptServiceOptions) {}

  async submit(submission: PromptSubmission): Promise<PromptReceipt> {
    if (this.options.isDisposed()) return { status: 'rejected', reason: 'Kimi session observation is disposed' };
    if (this.inFlight) return { status: 'rejected', reason: 'another Kimi prompt submission is awaiting echo' };

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
    const expectation = this.options.observer.expectPrompt(
      submission.text,
      submission.confirmationTimeoutMs ?? this.options.confirmationTimeoutMs ?? 10_000,
    );
    try {
      const injected = await this.options.host.automateTerminal(this.options.runtimeSessionId, {
        kind: 'paste',
        text: submission.text,
        submit: true,
      });
      if (!injected.accepted) {
        expectation.cancel();
        return { status: 'rejected', reason: injected.reason };
      }
      void this.options.observer.poll();
      const echo = await expectation.promise;
      return echo.matched ? { status: 'confirmed' } : { status: 'uncertain', reason: echo.reason };
    } finally {
      this.inFlight = false;
    }
  }
}
