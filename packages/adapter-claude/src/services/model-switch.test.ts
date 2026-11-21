import { describe, expect, it } from 'vitest';
import type { TerminalAutomationOperation, TerminalAutomationResult } from '@vibefield/puppeteer-core';
import { CLAUDE_COMMAND_SETTLE_MS, createClaudeModelSwitch } from './model-switch.js';

function terminal(results: TerminalAutomationResult[] = []) {
  const log: (TerminalAutomationOperation | { slept: number })[] = [];
  let blocked: string | undefined;
  let disposed = false;
  const service = createClaudeModelSwitch({
    automate: async (operation) => {
      log.push(operation);
      return results.shift() ?? { accepted: true };
    },
    isDisposed: () => disposed,
    blocked: () => blocked,
    sleep: async (ms) => {
      log.push({ slept: ms });
    },
  });
  return {
    log,
    service,
    block: (reason: string | undefined) => (blocked = reason),
    dispose: () => (disposed = true),
  };
}

describe('createClaudeModelSwitch', () => {
  it('offers the model and the effort, and says Claude keeps a switch as its default', () => {
    expect(terminal().service.offer).toEqual({ model: true, controls: ['effort'], persistence: 'default' });
  });

  it("types Claude's own model command, waits for the picker, then presses Enter once", async () => {
    const claude = terminal();
    await expect(claude.service.submit({ kind: 'model', modelId: 'sonnet[1m]' })).resolves.toEqual({ status: 'sent' });
    expect(claude.log).toEqual([
      { kind: 'text', text: '/model sonnet[1m]' },
      { slept: CLAUDE_COMMAND_SETTLE_MS },
      { kind: 'text', text: '\r' },
    ]);
  });

  it("types Claude's own effort command for the effort control", async () => {
    const claude = terminal();
    await expect(claude.service.submit({ kind: 'control', controlId: 'effort', value: 'xhigh' })).resolves.toEqual({
      status: 'sent',
    });
    expect(claude.log[0]).toEqual({ kind: 'text', text: '/effort xhigh' });
  });

  it('types nothing for a word that is not a model, a level, or a control it knows', async () => {
    const refused = {
      status: 'rejected',
      reason: 'not a model or an effort level Claude can be asked for',
      retryable: false,
    };
    const claude = terminal();
    for (const modelId of ['', 'opus\r/exit', 'opus now', '-opus', 'opus;ls'])
      await expect(claude.service.submit({ kind: 'model', modelId })).resolves.toEqual(refused);
    for (const value of ['', 'High', 'status', 'ultracode', 'high\r', 'max on'])
      await expect(claude.service.submit({ kind: 'control', controlId: 'effort', value })).resolves.toEqual(refused);
    await expect(claude.service.submit({ kind: 'control', controlId: 'thinking', value: 'on' })).resolves.toEqual(
      refused,
    );
    expect(claude.log).toEqual([]);
  });

  it('types nothing while a prompt is in flight or a native dialog is up, and says which', async () => {
    const claude = terminal();
    claude.block('native permission dialog pending');
    await expect(claude.service.submit({ kind: 'model', modelId: 'opus' })).resolves.toEqual({
      status: 'rejected',
      reason: 'native permission dialog pending',
    });
    expect(claude.log).toEqual([]);
    claude.block(undefined);
    await expect(claude.service.submit({ kind: 'model', modelId: 'opus' })).resolves.toEqual({ status: 'sent' });
  });

  it("carries the host's refusal of the command, and presses no Enter after it", async () => {
    const claude = terminal([{ accepted: false, reason: 'human-input-conflict' }]);
    await expect(claude.service.submit({ kind: 'model', modelId: 'opus' })).resolves.toEqual({
      status: 'rejected',
      reason: 'human-input-conflict',
    });
    expect(claude.log).toEqual([{ kind: 'text', text: '/model opus' }]);
  });

  it('says a typed command whose Enter was refused cannot be retried', async () => {
    const claude = terminal([{ accepted: true }, { accepted: false, reason: 'human-input-conflict' }]);
    await expect(claude.service.submit({ kind: 'model', modelId: 'opus' })).resolves.toEqual({
      status: 'rejected',
      reason: 'the command was typed and its Enter was refused: human-input-conflict',
      retryable: false,
    });
  });

  it('refuses a second switch while the first is between its command and its Enter', async () => {
    let release!: () => void;
    const operations: TerminalAutomationOperation[] = [];
    const service = createClaudeModelSwitch({
      automate: async (operation) => {
        operations.push(operation);
        return { accepted: true };
      },
      isDisposed: () => false,
      blocked: () => undefined,
      sleep: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const first = service.submit({ kind: 'model', modelId: 'opus' });
    await Promise.resolve();
    await Promise.resolve();
    await expect(service.submit({ kind: 'control', controlId: 'effort', value: 'low' })).resolves.toEqual({
      status: 'rejected',
      reason: 'another model switch is active',
    });
    release();
    await expect(first).resolves.toEqual({ status: 'sent' });
    expect(operations).toEqual([
      { kind: 'text', text: '/model opus' },
      { kind: 'text', text: '\r' },
    ]);
  });

  it('types nothing once the binding is disposed', async () => {
    const claude = terminal();
    claude.dispose();
    await expect(claude.service.submit({ kind: 'model', modelId: 'opus' })).resolves.toEqual({
      status: 'rejected',
      reason: 'the agent binding is disposed',
      retryable: false,
    });
    expect(claude.log).toEqual([]);
  });
});
