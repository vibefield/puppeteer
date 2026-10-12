import type { AgentEvent, PromptReceipt, PromptSubmission } from '@vibefield/puppeteer-core';
import type { HermesGatewayTransport } from '../transport/jsonrpc.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface HermesPromptServiceOptions {
  transport: HermesGatewayTransport;
  liveSessionId: string;
  confirmationTimeoutMs?: number | undefined;
  isDisposed(): boolean;
}

/** Owns Hermes prompt serialization and message.start confirmation. */
export class HermesPromptService {
  private inFlight = false;
  private startWaiter: ((turnId: string | undefined) => void) | undefined;

  constructor(private readonly options: HermesPromptServiceOptions) {}

  observe(event: AgentEvent): void {
    if (event.type === 'turn:started') this.startWaiter?.(event.turnId);
  }

  async submit(submission: PromptSubmission): Promise<PromptReceipt> {
    if (this.options.isDisposed()) return { status: 'rejected', reason: 'Hermes session is disposed' };
    if (submission.mode === 'paste-only') {
      return { status: 'rejected', reason: 'Hermes structured submit does not stage paste-only text' };
    }
    if (this.inFlight) return { status: 'rejected', reason: 'another Hermes prompt submission is in flight' };
    this.inFlight = true;
    const timeoutMs = submission.confirmationTimeoutMs ?? this.options.confirmationTimeoutMs ?? 15_000;
    let cancelStartWait = (): void => undefined;
    const sawStart = new Promise<{ turnId?: string } | undefined>((resolve) => {
      let settled = false;
      const finish = (result: { turnId?: string } | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.startWaiter = undefined;
        resolve(result);
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      this.startWaiter = (turnId) => finish(turnId ? { turnId } : {});
      cancelStartWait = () => finish(undefined);
    });

    try {
      const result = await this.options.transport.request('prompt.submit', {
        session_id: this.options.liveSessionId,
        text: submission.text,
      });
      if (!isRecord(result) || result.status !== 'streaming') {
        return { status: 'uncertain', reason: 'prompt.submit did not return streaming' };
      }
      const started = await sawStart;
      return started
        ? { status: 'confirmed', ...started }
        : { status: 'uncertain', reason: `no message.start within ${timeoutMs}ms` };
    } catch (error) {
      return { status: 'rejected', reason: error instanceof Error ? error.message : String(error) };
    } finally {
      cancelStartWait();
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.startWaiter = undefined;
  }
}
