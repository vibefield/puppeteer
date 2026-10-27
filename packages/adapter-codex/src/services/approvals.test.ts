import type { InteractionEvent } from '@vibefield/puppeteer-core';
import { describe, expect, it, vi } from 'vitest';
import { NO_REPLY } from '../transport/app-server-client.js';
import {
  approvalResponse,
  CodexApprovalService,
  isApprovalRequest,
  KNOWN_SERVER_REQUESTS,
  UnsupportedServerRequestError,
  type CodexApprovalServiceOptions,
} from './approvals.js';

/**
 * Vocabularies verified against `codex app-server generate-json-schema`
 * (codex-cli 0.150.0). The point of these tests is that the abstract
 * 'approved' | 'denied' never reaches the wire unchanged.
 */
describe('Codex approval service responses', () => {
  it('answers the legacy pair with ReviewDecision', () => {
    for (const method of ['execCommandApproval', 'applyPatchApproval']) {
      expect(approvalResponse(method, 'approved')).toEqual({ decision: 'approved' });
      // Denial is an OBJECT here, with a required `rejection` — the bare string
      // 'denied' is not a member of ReviewDecision at all.
      expect(approvalResponse(method, 'denied')).toEqual({
        decision: { denied: { rejection: 'denied by puppeteer policy' } },
      });
    }
  });

  it('answers the current pair with accept/decline', () => {
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      expect(approvalResponse(method, 'approved')).toEqual({ decision: 'accept' });
      expect(approvalResponse(method, 'denied')).toEqual({ decision: 'decline' });
    }
  });

  it('never emits the abstract words on the wire', () => {
    const bodies = KNOWN_SERVER_REQUESTS.filter(isApprovalRequest).flatMap((method) => [
      JSON.stringify(approvalResponse(method, 'approved')),
      JSON.stringify(approvalResponse(method, 'denied')),
    ]);
    // 'approved' survives only where ReviewDecision genuinely defines it.
    expect(bodies.filter((body) => body.includes('"denied":{'))).toHaveLength(2);
    expect(bodies.filter((body) => body === '{"decision":"denied"}')).toHaveLength(0);
  });

  it('refuses non-approval server requests rather than sending a wrong body', () => {
    // These ask the client for a capability (tool output, user input, tokens).
    // A `{decision}` reply would be well-formed JSON-RPC carrying a body the
    // server cannot parse — an error is the honest answer.
    for (const method of ['item/tool/call', 'attestation/generate', 'mcpServer/elicitation/request']) {
      expect(isApprovalRequest(method)).toBe(false);
      expect(() => approvalResponse(method, 'approved')).toThrow(UnsupportedServerRequestError);
    }
  });

  it('treats an unknown method as unsupported, not as an approval', () => {
    expect(() => approvalResponse('some/future/request', 'denied')).toThrow(UnsupportedServerRequestError);
  });

  it('carries a caller-supplied rejection reason into the legacy denial', () => {
    expect(approvalResponse('execCommandApproval', 'denied', 'sandbox is read-only')).toEqual({
      decision: { denied: { rejection: 'sandbox is read-only' } },
    });
  });
});

/**
 * Who answers. Codex 0.164.0 sends a thread's requests to every subscribed
 * connection, acts on the first reply (codex-rs/app-server
 * `outgoing_message.rs`), then tells every connection `serverRequest/resolved`.
 */
describe('CodexApprovalService', () => {
  const COMMAND = 'item/commandExecution/requestApproval';
  const PROMPTS = ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/permissions/requestApproval'];
  const commandParams = { threadId: 'th', turnId: 'turn-1', itemId: 'call-1', command: 'curl https://example.com' };
  const resolvedNotice = (requestId: number) => ({ threadId: 'th', requestId });
  const unknownOutcome = (requestId: string) => ({
    type: 'interaction:permission-resolved',
    requestId,
    outcome: 'unknown',
  });

  function service(options: Partial<CodexApprovalServiceOptions> = {}) {
    const published: InteractionEvent[] = [];
    const approvals = new CodexApprovalService({
      publish: (event) => published.push(event),
      isDisposed: () => false,
      ...options,
    });
    return { approvals, published };
  }

  it('denies at once where it is the only client (the headless driver)', async () => {
    const { approvals, published } = service();
    await expect(approvals.handle(COMMAND, commandParams, 7)).resolves.toEqual({ decision: 'decline' });
    expect(published).toEqual([
      {
        type: 'interaction:permission-requested',
        requestId: '7',
        toolCallId: 'call-1',
        tool: 'command',
        input: commandParams,
        presentation: 'host-ui',
      },
      { type: 'interaction:permission-resolved', requestId: '7', outcome: 'denied' },
    ]);
    expect(approvals.pendingCount).toBe(0);
  });

  it('defers to the TUI: no reply, and the wait stays pending until Codex resolves it', async () => {
    const { approvals, published } = service({ unhandled: 'defer' });
    await expect(approvals.handle(COMMAND, commandParams, 7)).resolves.toBe(NO_REPLY);
    expect(published).toEqual([expect.objectContaining({ requestId: '7', presentation: 'native-tui' })]);
    expect(approvals.pendingCount).toBe(1);

    approvals.observe('serverRequest/resolved', resolvedNotice(8));
    approvals.observe('turn/completed', { threadId: 'th', turn: { id: 'turn-1' } });
    expect(approvals.pendingCount).toBe(1);

    approvals.observe('serverRequest/resolved', resolvedNotice(7));
    expect(published.at(-1)).toEqual(unknownOutcome('7'));
    expect(approvals.pendingCount).toBe(0);
    approvals.observe('serverRequest/resolved', resolvedNotice(7));
    expect(published).toHaveLength(2);
  });

  it('leaves every prompt the TUI asks the person to them, even with a host decision', async () => {
    const decide = vi.fn(() => 'approved' as const);
    const { approvals } = service({ unhandled: 'defer', decide });
    for (const [id, method] of PROMPTS.entries()) {
      await expect(approvals.handle(method, { threadId: 'th', itemId: `item-${id}` }, id)).resolves.toBe(NO_REPLY);
    }
    expect(decide).not.toHaveBeenCalled();
    expect(approvals.pendingCount).toBe(PROMPTS.length);
  });

  it('keeps refusing a capability request no person answers', async () => {
    const { approvals, published } = service({ unhandled: 'defer' });
    await expect(approvals.handle('item/tool/call', { threadId: 'th' }, 9)).rejects.toThrow(
      UnsupportedServerRequestError,
    );
    expect(published.map((event) => event.type)).toEqual([
      'interaction:permission-requested',
      'interaction:permission-resolved',
    ]);
    expect(approvals.pendingCount).toBe(0);
  });

  it('answers with a host decision that comes first, and ignores the resolution after it', async () => {
    const decide = vi.fn(() => 'approved' as const);
    const { approvals, published } = service({ unhandled: 'defer', decide });
    await expect(approvals.handle(COMMAND, commandParams, 7)).resolves.toEqual({ decision: 'accept' });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ requestId: 7, signal: expect.any(AbortSignal) }));
    approvals.observe('serverRequest/resolved', resolvedNotice(7));
    expect(published).toMatchObject([
      { type: 'interaction:permission-requested', presentation: 'host-ui' },
      { type: 'interaction:permission-resolved', outcome: 'allowed' },
    ]);
    expect(published).toHaveLength(2);
  });

  it('drops a host decision the person beat in the TUI, and aborts it', async () => {
    let decided!: (decision: 'approved') => void;
    let signal: AbortSignal | undefined;
    const { approvals, published } = service({
      unhandled: 'defer',
      decide: (request) => {
        signal = request.signal;
        return new Promise((resolve) => {
          decided = resolve;
        });
      },
    });
    const reply = approvals.handle(COMMAND, commandParams, 7);
    approvals.observe('serverRequest/resolved', resolvedNotice(7));
    expect(signal?.aborted).toBe(true);
    decided('approved');

    await expect(reply).resolves.toBe(NO_REPLY);
    expect(published.slice(1)).toEqual([unknownOutcome('7')]);
  });

  it('leaves the request to the person when the host cannot decide', async () => {
    const { approvals, published } = service({
      unhandled: 'defer',
      decide: () => Promise.reject(new Error('host dialog failed')),
    });
    await expect(approvals.handle(COMMAND, commandParams, 7)).resolves.toBe(NO_REPLY);
    expect(published).toHaveLength(1);
    expect(approvals.pendingCount).toBe(1);
    approvals.observe('serverRequest/resolved', resolvedNotice(7));
    expect(published.at(-1)).toEqual(unknownOutcome('7'));
  });

  it('settles every held request when no resolution can arrive', async () => {
    let signal: AbortSignal | undefined;
    const { approvals, published } = service({
      unhandled: 'defer',
      decide: (request) => {
        signal = request.signal;
        return new Promise(() => undefined);
      },
    });
    await expect(approvals.handle(PROMPTS[0]!, { threadId: 'th' }, 6)).resolves.toBe(NO_REPLY);
    void approvals.handle(COMMAND, commandParams, 7);

    approvals.settleAll('unknown', { lifecycle: 'dispose' });
    expect(signal?.aborted).toBe(true);
    expect(approvals.pendingCount).toBe(0);
    expect(published.filter((event) => event.type === 'interaction:permission-resolved')).toEqual([
      unknownOutcome('6'),
      unknownOutcome('7'),
    ]);
  });
});
