import { describe, expect, it } from 'vitest';
import { createPromptInjector, type PromptReceipt } from './prompt.js';
import type { TerminalAutomationOperation } from '@vibefield/puppeteer-core';

function harness(defaults?: { defaultConfirmationTimeoutMs?: number; accepted?: boolean }) {
  const operations: TerminalAutomationOperation[] = [];
  const injector = createPromptInjector({
    automate: async (operation) => {
      operations.push(operation);
      return defaults?.accepted === false ? { accepted: false, reason: 'human-input-conflict' } : { accepted: true };
    },
    defaultConfirmationTimeoutMs: defaults?.defaultConfirmationTimeoutMs,
  });
  return { operations, injector };
}

describe('createPromptInjector', () => {
  it('submits one atomic semantic paste-and-submit operation', async () => {
    const { operations, injector } = harness();
    const receiptPromise = injector.submit({ text: 'run the tests' });
    expect(operations).toEqual([{ kind: 'paste', text: 'run the tests', submit: true }]);

    injector.handleTurnStarted('prompt-1', 'run the tests');
    expect(await receiptPromise).toEqual({ status: 'confirmed', turnId: 'prompt-1' });
  });

  it('does NOT misattribute someone else’s turn: mismatched prompts keep waiting', async () => {
    const { injector } = harness({ defaultConfirmationTimeoutMs: 60 });
    const receiptPromise = injector.submit({ text: 'my injected prompt' });

    injector.handleTurnStarted('prompt-user', 'something the human typed');
    // Still active — the mismatch was ignored rather than claimed.
    expect(injector.isActive()).toBe(true);

    const receipt = await receiptPromise;
    expect(receipt.status).toBe('uncertain'); // timed out honestly
  });

  it('normalizes line endings for matching but preserves inner newlines', async () => {
    const { operations, injector } = harness();
    const receiptPromise = injector.submit({ text: 'line one\r\nline two\n' });
    expect(operations[0]).toEqual({ kind: 'paste', text: 'line one\nline two', submit: true });

    injector.handleTurnStarted('p', 'line one\nline two');
    expect((await receiptPromise).status).toBe('confirmed');
  });

  describe('a long paste Claude Code wraps before UserPromptSubmit (2.1.332)', () => {
    const LONG = Array.from(
      { length: 10 },
      (_, index) =>
        `Step ${index + 1}: read the failing test, find the cause, fix it, and run the package suite again.`,
    ).join('\n');
    const wrapped = (text: string, id = 'd2c1') =>
      `\n\n<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">\n`;

    it('confirms when the whole prompt is our text in one wrapper', async () => {
      const { injector } = harness();
      const receipt = injector.submit({ text: LONG });
      injector.handleTurnStarted('p-long', wrapped(LONG));
      expect(await receipt).toEqual({ status: 'confirmed', turnId: 'p-long' });
    });

    it('confirms across CRLF line endings inside and around the wrapper', async () => {
      const { injector } = harness();
      const receipt = injector.submit({ text: `${LONG}\n` });
      const crlf = LONG.replace(/\n/g, '\r\n');
      injector.handleTurnStarted(
        'p-crlf',
        `\r\n<pasted_content id="7e0b">\r\n${crlf}\r\n</pasted_content id="7e0b">\r\n`,
      );
      expect(await receipt).toEqual({ status: 'confirmed', turnId: 'p-crlf' });
    });

    it('confirms a paste whose own text carries the tag', async () => {
      const { injector } = harness();
      const text = `${LONG}\nThe hook showed </pasted_content id="d2c1"> and <pasted_content id="ab12"> in it.`;
      const receipt = injector.submit({ text });
      injector.handleTurnStarted('p-tags', wrapped(text));
      expect(await receipt).toEqual({ status: 'confirmed', turnId: 'p-tags' });
    });

    it('does not confirm a wrapper around different text', async () => {
      const { injector } = harness({ defaultConfirmationTimeoutMs: 60 });
      const receipt = injector.submit({ text: LONG });
      injector.handleTurnStarted('p-other', wrapped(`${LONG}\nand one more line`));
      expect(injector.isActive()).toBe(true);
      expect((await receipt).status).toBe('uncertain');
    });

    it('does not confirm tags that name two pastes', async () => {
      const { injector } = harness({ defaultConfirmationTimeoutMs: 60 });
      const receipt = injector.submit({ text: LONG });
      injector.handleTurnStarted('p-ids', `\n\n<pasted_content id="d2c1">\n${LONG}\n</pasted_content id="a64d">\n`);
      expect((await receipt).status).toBe('uncertain');
    });

    it('does not confirm our paste joined to a draft: the prompt holds someone else’s text', async () => {
      const { injector } = harness({ defaultConfirmationTimeoutMs: 60 });
      const receipt = injector.submit({ text: LONG });
      injector.handleTurnStarted('p-draft', `a draft already typed\n\n${wrapped(LONG, 'a64d').trimStart()}`);
      expect(injector.isActive()).toBe(true);
      expect((await receipt).status).toBe('uncertain');
    });
  });

  it('rejects concurrent injections instead of interleaving', async () => {
    const { injector } = harness({ defaultConfirmationTimeoutMs: 60 });
    const first = injector.submit({ text: 'first' });
    const second = await injector.submit({ text: 'second' });
    expect(second).toEqual({ status: 'rejected', reason: 'another injection is active' });
    injector.handleTurnStarted('t1', 'first');
    expect((await first).status).toBe('confirmed');
  });

  it('rejects while a native permission dialog is pending', async () => {
    const { operations, injector } = harness();
    injector.setPermissionPending(true);
    expect((await injector.submit({ text: 'blocked' })).status).toBe('rejected');
    expect(operations).toHaveLength(0);

    injector.setPermissionPending(false);
    const receipt = injector.submit({ text: 'now ok' });
    injector.handleTurnStarted('t', 'now ok');
    expect((await receipt).status).toBe('confirmed');
  });

  it('tracks a native question gate independently from permission state', async () => {
    const { operations, injector } = harness();
    injector.setQuestionPending(true);
    expect(await injector.submit({ text: 'cannot bypass the chooser' })).toEqual({
      status: 'rejected',
      reason: 'native question dialog pending',
    });
    expect(operations).toHaveLength(0);

    injector.setPermissionPending(true);
    injector.setQuestionPending(false);
    expect((await injector.submit({ text: 'permission still blocks' })).status).toBe('rejected');
    injector.setPermissionPending(false);

    const receipt = injector.submit({ text: 'both clear' });
    injector.handleTurnStarted('t-clear', 'both clear');
    expect(await receipt).toEqual({ status: 'confirmed', turnId: 't-clear' });
  });

  it('rejects when accepted human input won the daemon ordering race', async () => {
    const { injector } = harness({ accepted: false });
    const receipt = await injector.submit({ text: 'automation prompt' });
    expect(receipt).toEqual({ status: 'rejected', reason: 'human-input-conflict' });
    expect(injector.isActive()).toBe(false);
  });

  it('paste-only stages without Enter and confirms immediately', async () => {
    const { operations, injector } = harness();
    const receipt = await injector.submit({ text: 'staged', mode: 'paste-only' });
    expect(receipt.status).toBe('confirmed');
    expect(operations).toEqual([{ kind: 'paste', text: 'staged', submit: false }]);
  });

  it('rejects empty prompts for good, before touching the terminal', async () => {
    const { operations, injector } = harness();
    expect(await injector.submit({ text: '\n' })).toEqual({
      status: 'rejected',
      reason: 'empty prompt',
      retryable: false,
    });
    expect(operations).toHaveLength(0);
  });

  it('times out as uncertain, never as a false confirmation', async () => {
    const { injector } = harness();
    const receipt: PromptReceipt = await injector.submit({ text: 'lost', confirmationTimeoutMs: 40 });
    expect(receipt.status).toBe('uncertain');
    expect((receipt as { reason: string }).reason).toContain('no matching UserPromptSubmit');
  });
});
