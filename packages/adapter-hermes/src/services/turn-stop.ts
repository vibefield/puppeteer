import type { AgentTurnStop, AgentTurnStopReceipt, AgentTurnStopService } from '@vibefield/puppeteer-core';
import type { HermesGatewayTransport } from '../transport/jsonrpc.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface HermesTurnStopServiceOptions {
  transport: HermesGatewayTransport;
  liveSessionId: string;
  isDisposed(): boolean;
}

/**
 * Hermes's turn stop is the gateway's own `session.interrupt`, the request
 * its TUI sends when a press does interrupt (`ui-tui/src/app/turnController.ts`).
 * No single key of the installed 0.21.4 stops a busy turn and never quits:
 * Ctrl-C clears a draft, interrupts a busy turn with an empty composer, and
 * exits an idle Hermes with an empty composer; Esc never interrupts a turn
 * (`ui-tui/src/app/useInputHandlers.ts`). The request stops the live turn,
 * drops queued prompts and declines an open approval; on an idle session it
 * ends nothing (`tui_gateway/methods_session.py`). The TUI's own resume reuses
 * the live session this binding created, so this is the turn the pane shows.
 */
export class HermesTurnStopService implements AgentTurnStopService {
  readonly stop: AgentTurnStop = { kind: 'native' };

  constructor(private readonly options: HermesTurnStopServiceOptions) {}

  async submit(): Promise<AgentTurnStopReceipt> {
    if (this.options.isDisposed()) return { accepted: false, reason: 'Hermes session is disposed' };
    try {
      const result = await this.options.transport.request('session.interrupt', {
        session_id: this.options.liveSessionId,
      });
      if (isRecord(result) && result.status === 'interrupted') return { accepted: true };
      return { accepted: false, reason: 'session.interrupt did not answer interrupted' };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
