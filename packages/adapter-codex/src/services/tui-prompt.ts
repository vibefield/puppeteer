import type { AgentHost, PromptReceipt, PromptSubmission } from '@vibefield/puppeteer-core';
import type { CodexObserver } from '../observation/observer.js';

interface Pending {
  text: string;
  accepted: boolean;
  echo?: PromptReceipt;
  resolve(receipt: PromptReceipt): void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Match a future native echo, while leaving all input (including slash commands) in the TUI. */
export class CodexTuiPromptService {
  private pending: Pending | undefined;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly seen = new Set<string>();
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly options: {
      observer: Pick<CodexObserver, 'onUserMessage' | 'onUnavailable' | 'observationLevel'>;
      host: Pick<AgentHost, 'automateTerminal'>;
      runtimeSessionId: string;
    },
  ) {
    this.unsubscribe = [
      options.observer.onUserMessage((message) => {
        if (this.seen.has(message.id)) return;
        this.seen.add(message.id);
        if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
        const pending = this.pending;
        if (!pending || message.text !== pending.text) return;
        pending.echo = { status: 'confirmed', turnId: message.turnId };
        if (pending.accepted) this.settle(pending.echo);
      }),
      options.observer.onUnavailable(() =>
        this.settle({ status: 'uncertain', reason: 'Codex observation became unavailable before confirmation' }),
      ),
    ];
  }

  submit(submission: PromptSubmission): Promise<PromptReceipt> {
    // The terminal composer is shared state; overlapping pastes cannot be correlated reliably.
    const result = this.queue.then(() => this.send(submission));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async send(submission: PromptSubmission): Promise<PromptReceipt> {
    if (this.disposed) return { status: 'rejected', reason: 'Codex TUI session is disposed' };
    const timeoutMs = submission.confirmationTimeoutMs ?? 5000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return { status: 'rejected', reason: 'Prompt confirmation timeout must be positive' };
    let resolve!: (receipt: PromptReceipt) => void;
    const receipt = new Promise<PromptReceipt>((r) => {
      resolve = r;
    });
    const pending: Pending = { text: submission.text, accepted: false, resolve };
    this.pending = pending;
    try {
      const result = await this.options.host.automateTerminal(this.options.runtimeSessionId, {
        kind: 'paste',
        text: submission.text,
        submit: submission.mode !== 'paste-only',
      });
      if (!result.accepted) this.settle({ status: 'rejected', reason: result.reason });
      else if (submission.mode === 'paste-only')
        this.settle({
          status: 'uncertain',
          reason: 'Text was staged in the native TUI without submitting a user message',
        });
      else if (this.pending === pending) {
        pending.accepted = true;
        if (pending.echo) this.settle(pending.echo);
        else if (this.options.observer.observationLevel() !== 'structured')
          this.settle({ status: 'uncertain', reason: 'Text was sent but Codex observation is unavailable' });
        else {
          pending.timer = setTimeout(
            () =>
              this.settle({
                status: 'uncertain',
                reason: `No matching native user message arrived within ${timeoutMs}ms`,
              }),
            timeoutMs,
          );
          pending.timer.unref?.();
        }
      }
    } catch (error) {
      this.settle({
        status: 'uncertain',
        reason: `Terminal submission could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return receipt;
  }

  private settle(receipt: PromptReceipt): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(receipt);
  }

  dispose(): void {
    this.disposed = true;
    this.settle({ status: 'uncertain', reason: 'Codex TUI session was disposed before confirmation' });
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.seen.clear();
  }
}
