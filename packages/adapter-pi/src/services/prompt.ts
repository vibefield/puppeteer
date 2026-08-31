import type { AgentHost, PromptReceipt, PromptSubmission } from '@vibecook/puppeteer-core';

export class PiPromptService {
  constructor(private readonly options: { host: AgentHost; runtimeSessionId: string; isDisposed(): boolean }) {}
  async submit(submission: PromptSubmission): Promise<PromptReceipt> {
    if (this.options.isDisposed()) return { status: 'rejected', reason: 'Pi session observation is disposed' };
    const submitted = await this.options.host.automateTerminal(this.options.runtimeSessionId, {
      kind: 'paste',
      text: submission.text,
      submit: submission.mode !== 'paste-only',
    });
    if (!submitted.accepted) return { status: 'rejected', reason: submitted.reason };
    return {
      status: 'uncertain',
      reason:
        submission.mode === 'paste-only'
          ? 'prompt text was staged but not submitted'
          : 'Pi durably flushes the user message only when the first assistant record is persisted',
    };
  }
}
