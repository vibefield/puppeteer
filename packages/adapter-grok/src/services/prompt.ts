import type { AgentAdapterBinding, PromptReceipt, PromptSubmission } from '@vibefield/puppeteer-core';
import type { GrokQueueChanged } from '../normalization/queue.js';

/**
 * Which id a confirmed receipt names: the turn the binding publishes for the prompt. With the log observer attached
 * the control rail starts it under Grok's own prompt id (`native-prompt`); the structured composition publishes
 * adapter-acp's turn (`acp-turn`).
 */
export type GrokPromptTurnIds = 'native-prompt' | 'acp-turn';

export interface GrokPromptServiceOptions {
  /** The ACP control binding: the attached one, or the attach in flight. Undefined when control never attached. */
  control(): Promise<AgentAdapterBinding | undefined>;
  turnIds: GrokPromptTurnIds;
}

interface PendingPrompt {
  readonly text: string;
  /** The ids Grok's queue named when this prompt registered: another client's prompts, never this one. */
  readonly knownIds: ReadonlySet<string>;
  /** adapter-acp's turn for this request, published inside its submit call. */
  acpTurnId?: string | undefined;
  /** Grok's own id for the prompt, bound when Grok lists it with the submitted text. */
  promptId?: string | undefined;
  readonly resolve: (receipt: PromptReceipt) => void;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

const RAIL_UNAVAILABLE: PromptReceipt = {
  status: 'rejected',
  reason: 'grok control rail unavailable',
  retryable: false,
};

const RAIL_CLOSED_REASON = 'the grok control rail closed before Grok accepted the prompt';

/**
 * What a Grok prompt receipt means. adapter-acp answers 'confirmed' as soon as it writes the session/prompt request,
 * before Grok has accepted anything, so this service confirms only on Grok's own acceptance: `_x.ai/queue/changed`
 * lists the prompt under a new id with the submitted text, then runs it (or lists it while another prompt runs). The
 * match is by text, as Claude's injector matches UserPromptSubmit; an id Grok listed before the submission registered
 * is never this submission's, because a person typing in the TUI races every write.
 * - No acceptance within the submission's bound (default 5 s) answers 'uncertain', as does a rail that closes or a
 *   binding disposed first (CP2-D2).
 * - A request Grok answers with an error before it listed the prompt answers 'rejected' with that error. After Grok
 *   listed it, the turn is Grok's, and the durable log tells how it ended.
 * - A request with no answer is 'uncertain', whichever the rail says first. A closing connection rejects what is in
 *   flight, normally before the rail hears the close, and the leader may hold that prompt.
 * - A closed rail or a disposed binding refuses every later submission for good (`retryable: false`), as a control
 *   that never attached does: nothing would carry it. A request with no answer closes the rail as well (the
 *   composition calls transportClosed): the SDK has closed, whether or not the rail has heard it yet.
 */
export class GrokPromptService {
  private readonly pending: PendingPrompt[] = [];
  /** The prompt inside adapter-acp's submit call, which publishes its turn synchronously. */
  private submitting: PendingPrompt | undefined;
  /** Every id the last own-session queue frame named. */
  private queuedIds: ReadonlySet<string> = new Set();
  private railClosed = false;
  private disposed = false;

  constructor(private readonly options: GrokPromptServiceOptions) {}

  async submit(submission: PromptSubmission): Promise<PromptReceipt> {
    if (this.railClosed || this.disposed) return RAIL_UNAVAILABLE;
    const acp = await this.options.control();
    // The rail can close, or the binding go, while the attach is awaited. No control means one of them already did.
    if (this.railClosed || this.disposed || !acp) return RAIL_UNAVAILABLE;

    let resolveReceipt!: (receipt: PromptReceipt) => void;
    const receipt = new Promise<PromptReceipt>((resolve) => {
      resolveReceipt = resolve;
    });
    // Registered before the request is written: Grok's frames can arrive inside the call.
    const entry: PendingPrompt = { text: submission.text, knownIds: this.queuedIds, resolve: resolveReceipt };
    this.pending.push(entry);
    let answered: Promise<PromptReceipt>;
    this.submitting = entry;
    try {
      answered = acp.services.prompt.submit(submission);
    } catch (error) {
      answered = Promise.reject(error);
    } finally {
      this.submitting = undefined;
    }
    const answer = await answered.catch((error: unknown): PromptReceipt => ({
      status: 'rejected',
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (answer.status !== 'confirmed') {
      this.settle(entry, answer);
    } else if (this.pending.includes(entry)) {
      entry.acpTurnId ??= answer.turnId;
      const timeoutMs = submission.confirmationTimeoutMs ?? 5000;
      entry.timer = setTimeout(() => {
        this.settle(entry, {
          status: 'uncertain',
          reason: `session/prompt was written but Grok accepted no matching prompt within ${timeoutMs}ms`,
        });
      }, timeoutMs);
      entry.timer.unref?.();
    }
    return receipt;
  }

  /** adapter-acp published its turn: inside a submit call, that turn is the submitted prompt's. */
  bindAcpTurn(acpTurnId: string): void {
    if (this.submitting) this.submitting.acpTurnId = acpTurnId;
  }

  /** The submitted text of the waiting prompt Grok listed under this id. */
  textOf(promptId: string): string | undefined {
    return this.pending.find((entry) => entry.promptId === promptId)?.text;
  }

  /** An own-session, live queue frame: bind new ids to waiting prompts by text, then confirm what Grok accepted. */
  observeQueue(queue: GrokQueueChanged): void {
    const named = [
      ...queue.entries.map(({ id, text }) => ({ id, text })),
      ...(queue.running ? [{ id: queue.running.promptId, text: queue.running.text }] : []),
    ];
    for (const { id, text } of named) {
      if (text === undefined || this.pending.some((entry) => entry.promptId === id)) continue;
      // Waiting prompts of equal text bind first in, first out.
      const entry = this.pending.find(
        (candidate) => candidate.promptId === undefined && candidate.text === text && !candidate.knownIds.has(id),
      );
      if (entry) entry.promptId = id;
    }
    const running = queue.running;
    if (running) {
      for (const entry of [...this.pending]) {
        const accepted =
          entry.promptId !== undefined &&
          (running.promptId === entry.promptId || queue.entries.some(({ id }) => id === entry.promptId));
        if (accepted) this.settle(entry, { status: 'confirmed', turnId: this.turnIdOf(entry) });
      }
    }
    this.queuedIds = new Set(named.map(({ id }) => id));
  }

  /**
   * adapter-acp's request failed. Before Grok listed the prompt the receipt says what came back: Grok's own error is
   * 'rejected', and no answer is what a closed rail answers. After, the turn is Grok's.
   */
  requestFailed(acpTurnId: string, error: string | undefined, answered: boolean): void {
    const entry = this.pending.find((candidate) => candidate.acpTurnId === acpTurnId);
    if (!entry || entry.promptId !== undefined) return;
    if (answered) this.settle(entry, { status: 'rejected', reason: error || 'grok control request failed' });
    else this.settle(entry, { status: 'uncertain', reason: RAIL_CLOSED_REASON });
  }

  /** The control rail closed: waiting prompts are uncertain, and nothing more can be submitted. */
  transportClosed(): void {
    this.railClosed = true;
    this.settleAll(RAIL_CLOSED_REASON);
  }

  dispose(): void {
    this.disposed = true;
    this.settleAll('the grok session was disposed before Grok accepted the prompt');
  }

  private turnIdOf(entry: PendingPrompt): string | undefined {
    return this.options.turnIds === 'native-prompt' ? entry.promptId : entry.acpTurnId;
  }

  private settle(entry: PendingPrompt, receipt: PromptReceipt): void {
    const index = this.pending.indexOf(entry);
    if (index < 0) return;
    this.pending.splice(index, 1);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(receipt);
  }

  private settleAll(reason: string): void {
    for (const entry of [...this.pending]) this.settle(entry, { status: 'uncertain', reason });
  }
}
