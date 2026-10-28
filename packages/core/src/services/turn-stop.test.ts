import { describe, expect, it } from 'vitest';
import type { TerminalAutomationOperation, TerminalAutomationResult } from '../host.js';
import { createKeyTurnStop, TERMINAL_KEY_TEXT } from './turn-stop.js';

function host(result: TerminalAutomationResult = { accepted: true }) {
  const operations: TerminalAutomationOperation[] = [];
  return {
    operations,
    automate: async (operation: TerminalAutomationOperation) => {
      operations.push(operation);
      return result;
    },
  };
}

describe('createKeyTurnStop', () => {
  it('names its key and presses it as one text operation', async () => {
    const terminal = host();
    const stop = createKeyTurnStop({ key: 'escape', automate: terminal.automate, isDisposed: () => false });
    expect(stop.stop).toEqual({ kind: 'key', key: 'escape' });
    await expect(stop.submit()).resolves.toEqual({ accepted: true });
    expect(terminal.operations).toEqual([{ kind: 'text', text: '\x1b' }]);
  });

  it("carries the host's refusal in its own words", async () => {
    const terminal = host({ accepted: false, reason: 'human-input-conflict' });
    const stop = createKeyTurnStop({ key: 'escape', automate: terminal.automate, isDisposed: () => false });
    await expect(stop.submit()).resolves.toEqual({ accepted: false, reason: 'human-input-conflict' });
  });

  it('presses nothing once the binding is disposed', async () => {
    const terminal = host();
    const stop = createKeyTurnStop({ key: 'escape', automate: terminal.automate, isDisposed: () => true });
    await expect(stop.submit()).resolves.toEqual({ accepted: false, reason: 'the agent binding is disposed' });
    expect(terminal.operations).toEqual([]);
  });

  it("writes each key as its legacy byte, ⌃C the byte Ghosttea's interrupt sends", () => {
    expect(TERMINAL_KEY_TEXT).toEqual({ escape: '\x1b', 'ctrl-c': '\x03' });
  });
});
