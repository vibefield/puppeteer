import {
  createKeyTurnStop,
  type AgentTurnStopService,
  type TerminalAutomationOperation,
  type TerminalAutomationResult,
} from '@vibefield/puppeteer-core';

/**
 * Claude Code's turn stop is Esc, its documented interrupt ("Interrupt Claude,
 * or close a dialog": https://code.claude.com/docs/en/interactive-mode). Ctrl-C
 * is not: on an idle Claude the first press clears the input and a second
 * exits. Two presses of Esc on an empty input open the rewind menu, never an
 * exit. Esc stops a turn at a permission prompt (2.1.308) and in the middle of
 * a reply (2.1.332), and fires no Stop hook either way: the turn ends at the
 * marker row the transcript writes (`projectClaudeTranscriptInterruptions`).
 * Esc under vim mode's INSERT is unmeasured.
 */
export function createClaudeTurnStop(options: {
  automate(operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
  isDisposed(): boolean;
}): AgentTurnStopService {
  return createKeyTurnStop({ key: 'escape', automate: options.automate, isDisposed: options.isDisposed });
}
