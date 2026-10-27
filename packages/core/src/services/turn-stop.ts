/**
 * The stop that ends an agent's current turn in its own TUI and never quits
 * it. It belongs to the adapter: the key that stops a turn in one TUI clears
 * the input or quits another (Ctrl-C clears Pi's editor, and exits an idle
 * Hermes), so neither a host nor a view may assume one.
 */

import type { TerminalAutomationOperation, TerminalAutomationResult } from '../host.js';

/** A key a person presses in an agent's terminal. */
export type TerminalKey = 'escape' | 'ctrl-c';

/**
 * How an agent's turn is stopped: a key its own TUI binds to that, or the
 * agent's own native control, which no key names.
 */
export type AgentTurnStop = { kind: 'key'; key: TerminalKey } | { kind: 'native' };

/**
 * `accepted` = the stop was delivered (the host took the key, or the agent's
 * control answered it), never that the turn ended.
 */
export type AgentTurnStopReceipt = { accepted: true } | { accepted: false; reason: string };

export interface AgentTurnStopService {
  /** What the stop is, so a host can name it before it is pressed. */
  readonly stop: AgentTurnStop;
  /** Stop the current turn. On an idle agent the stop still reaches it and quits nothing. */
  submit(): Promise<AgentTurnStopReceipt>;
}

/**
 * The text that presses a key through the host's `text` operation: the byte a
 * terminal sends for the key in its legacy encoding, the encoding Ghosttea's
 * own `interrupt` operation uses for ⌃C.
 */
export const TERMINAL_KEY_TEXT: Readonly<Record<TerminalKey, string>> = {
  escape: '\x1b',
  'ctrl-c': '\x03',
};

export interface KeyTurnStopOptions {
  key: TerminalKey;
  /** The host's automation, bound to the agent's own terminal. */
  automate(operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
  isDisposed(): boolean;
}

/**
 * A turn stop that presses one key in the agent's terminal. The key travels as
 * one semantic automation operation, so the host orders it against accepted
 * human input like a prompt, and it never lands inside a person's keystroke.
 */
export function createKeyTurnStop(options: KeyTurnStopOptions): AgentTurnStopService {
  return {
    stop: { kind: 'key', key: options.key },
    async submit() {
      if (options.isDisposed()) return { accepted: false, reason: 'the agent binding is disposed' };
      const result = await options.automate({ kind: 'text', text: TERMINAL_KEY_TEXT[options.key] });
      return result.accepted ? { accepted: true } : { accepted: false, reason: result.reason };
    },
  };
}
