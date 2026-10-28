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
 * exit. Esc has been witnessed stopping a turn at a permission prompt only
 * (2.1.308, where it fires no Stop hook: `normalization/pipeline.ts`); a stop
 * mid-reply, and Esc under vim mode's INSERT, are VibeField's QA wave 1 census.
 */
export function createClaudeTurnStop(options: {
  automate(operation: TerminalAutomationOperation): Promise<TerminalAutomationResult>;
  isDisposed(): boolean;
}): AgentTurnStopService {
  return createKeyTurnStop({ key: 'escape', automate: options.automate, isDisposed: options.isDisposed });
}
