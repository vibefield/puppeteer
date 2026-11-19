import type { AdapterEventCandidate, AgentAdapterEventSource, PromptReceipt } from '@vibefield/puppeteer-core';

/**
 * Confirms a prompt pasted into a managed Codex TUI on the thread's own record of it, as Claude's injector confirms
 * on UserPromptSubmit (adapter-claude `services/prompt.ts`).
 *
 * A paste the terminal accepted is not yet a prompt: it can land on a draft the person was typing, behind a picker,
 * or in a composer that never submits it. The observer is on the same thread, and Codex records every submitted
 * input as a `userMessage` item, which the turn normalizer publishes as `turn:started` with that item's text. So a
 * submission is `confirmed` only when a live `turn:started` carries a prompt equal to the pasted text, and
 * `uncertain` when none does within its bound.
 * - A different input does not settle anything: it is someone else's turn, and timing out as uncertain beats
 *   claiming it as ours. A draft glued to our text never matches, so it ends uncertain.
 * - Texts are compared with line endings normalized and trailing whitespace dropped.
 * - Waiting submissions of equal text match first in, first out.
 * - A replayed `turn:started` (the thread's history) never confirms anything.
 */
export function echoText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimEnd();
}

/** One submission waiting for its echo. */
export interface PromptEchoWait {
  /** Settles with the receipt; `confirmed` may arrive before {@link arm} (the echo can come inside the paste). */
  readonly receipt: Promise<PromptReceipt>;
  /** The paste was accepted: start the bound. */
  arm(timeoutMs: number): void;
  /** The paste never went out: stop waiting and settle with `receipt`. */
  withdraw(receipt: PromptReceipt): void;
}

interface Waiting {
  readonly text: string;
  readonly resolve: (receipt: PromptReceipt) => void;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

export class CodexPromptEchoes {
  private readonly waiting: Waiting[] = [];
  private unsubscribe: (() => void) | undefined;
  private disposed = false;

  /**
   * `events` is the observer's stream. It is subscribed only while a submission waits, never at adoption: the
   * observer replays the thread's history to its first subscriber, which is the runtime's.
   */
  constructor(private readonly events: AgentAdapterEventSource) {}

  /** Register before the paste is written, so an echo that arrives inside the paste is heard. */
  expect(text: string): PromptEchoWait {
    let resolve!: (receipt: PromptReceipt) => void;
    const receipt = new Promise<PromptReceipt>((settle) => {
      resolve = settle;
    });
    const entry: Waiting = { text: echoText(text), resolve };
    if (this.disposed) {
      resolve({ status: 'rejected', reason: 'codex session is disposed', retryable: false });
    } else {
      this.waiting.push(entry);
      this.unsubscribe ??= this.events.onCandidate((candidate) => this.observe(candidate));
    }
    return {
      receipt,
      arm: (timeoutMs) => {
        if (!this.waiting.includes(entry)) return;
        entry.timer = setTimeout(() => {
          this.settle(entry, {
            status: 'uncertain',
            reason: `no matching input on the thread within ${timeoutMs}ms (a draft, a picker, or a busy input?)`,
          });
        }, timeoutMs);
        entry.timer.unref?.();
      },
      withdraw: (withdrawn) => this.settle(entry, withdrawn),
    };
  }

  /** Waiting submissions are uncertain, and later ones are refused. */
  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.waiting]) {
      this.settle(entry, {
        status: 'uncertain',
        reason: 'the codex session was disposed before its thread recorded the prompt',
      });
    }
  }

  private observe(candidate: AdapterEventCandidate): void {
    if (candidate.replay || candidate.event.type !== 'turn:started') return;
    const { prompt, turnId } = candidate.event;
    if (prompt === undefined) return;
    const text = echoText(prompt);
    const entry = this.waiting.find((waiting) => waiting.text === text);
    if (entry) this.settle(entry, { status: 'confirmed', turnId });
  }

  private settle(entry: Waiting, receipt: PromptReceipt): void {
    const index = this.waiting.indexOf(entry);
    if (index < 0) return;
    this.waiting.splice(index, 1);
    if (entry.timer) clearTimeout(entry.timer);
    if (this.waiting.length === 0) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
    entry.resolve(receipt);
  }
}
