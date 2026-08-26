import type { PromptReceipt, PromptSubmission } from '@vibecook/puppeteer-core';
import { AppServerRequestTimeoutError } from '../transport/app-server-client.js';

interface PendingPrompt {
  resolve: (receipt: PromptReceipt) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface CodexPromptServiceOptions {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  runtimeSessionId(): string;
  isDisposed(): boolean;
}

/** Adapts prompt submission and protocol echo correlation to the Core prompt service. */
export class CodexPromptService {
  private readonly pending = new Map<string, PendingPrompt>();
  private sequence = 0;

  constructor(private readonly options: CodexPromptServiceOptions) {}

  confirm(clientUserMessageId: string, turnId?: string): void {
    this.settle(clientUserMessageId, { status: 'confirmed', turnId });
  }

  transportClosed(): void {
    this.settleAll('app-server transport closed before matching clientUserMessageId arrived');
  }

  dispose(): void {
    this.settleAll('codex session disposed before matching clientUserMessageId arrived');
  }

  async submit(submission: PromptSubmission): Promise<PromptReceipt> {
    if (this.options.isDisposed()) return { status: 'rejected', reason: 'codex session is disposed' };
    const clientUserMessageId = `puppeteer-inj-${++this.sequence}`;
    let resolveReceipt!: (receipt: PromptReceipt) => void;
    const receipt = new Promise<PromptReceipt>((resolve) => {
      resolveReceipt = resolve;
    });
    this.pending.set(clientUserMessageId, { resolve: resolveReceipt });

    try {
      await this.options.request('turn/start', {
        threadId: this.options.runtimeSessionId(),
        input: [{ type: 'text', text: submission.text }],
        clientUserMessageId,
      });
      const pending = this.pending.get(clientUserMessageId);
      if (pending) {
        const timeoutMs = submission.confirmationTimeoutMs ?? 5000;
        pending.timer = setTimeout(() => {
          this.settle(clientUserMessageId, {
            status: 'uncertain',
            reason: `turn/start succeeded but no matching clientUserMessageId arrived within ${timeoutMs}ms`,
          });
        }, timeoutMs);
        pending.timer.unref?.();
      }
      return await receipt;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.settle(
        clientUserMessageId,
        error instanceof AppServerRequestTimeoutError
          ? { status: 'uncertain', reason }
          : { status: 'rejected', reason },
      );
      return await receipt;
    }
  }

  private settle(clientUserMessageId: string, receipt: PromptReceipt): void {
    const pending = this.pending.get(clientUserMessageId);
    if (!pending) return;
    this.pending.delete(clientUserMessageId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(receipt);
  }

  private settleAll(reason: string): void {
    for (const clientUserMessageId of [...this.pending.keys()]) {
      this.settle(clientUserMessageId, { status: 'uncertain', reason });
    }
  }
}
