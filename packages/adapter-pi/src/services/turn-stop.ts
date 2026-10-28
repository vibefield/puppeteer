import { createKeyTurnStop, type AgentHost, type AgentTurnStopService } from '@vibefield/puppeteer-core';

/**
 * Pi's turn stop is Esc: `app.interrupt` ("Cancel or abort") in the installed
 * 0.87.1's keybindings (`dist/core/keybindings.js`). Ctrl-C is `app.clear`
 * there ("Clear editor"), and a second within 500 ms quits Pi, so ⌃C never
 * stops a Pi turn. Pi's TUI reads the lone ESC byte as Esc whether or not it
 * turned the kitty keyboard protocol on (pi-tui's `matchesKey`).
 */
export function createPiTurnStop(options: {
  host: AgentHost;
  runtimeSessionId: string;
  isDisposed(): boolean;
}): AgentTurnStopService {
  return createKeyTurnStop({
    key: 'escape',
    automate: (operation) => options.host.automateTerminal(options.runtimeSessionId, operation),
    isDisposed: options.isDisposed,
  });
}
