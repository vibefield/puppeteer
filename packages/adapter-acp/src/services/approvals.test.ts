import type { PermissionOption } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { AcpApprovalService, acpPermissionOutcome } from './approvals.js';

// Option ids, names, kinds, and order exactly as Grok offered them over ACP
// (packages/surface/vendors/grok/captures/grok@1.0.70/*/observations.json).
const GROK_1_0_70_BASH: PermissionOption[] = [
  { optionId: 'always-allow', name: "Yes, and don't ask again for bash commands", kind: 'allow_always' },
  { optionId: 'allow-once', name: 'Yes, proceed', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
  { optionId: 'reject-always', name: "No, and don't ask again for this command", kind: 'reject_always' },
];
// Grok 1.0.0 (and 1.0.70 spawn_subagent or GROK_REMEMBER_TOOL_APPROVALS=0).
const GROK_TWO_OPTION: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Yes, proceed', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'No, and tell Grok what to do differently', kind: 'reject_once' },
];

function selected(optionId: string) {
  return { outcome: { outcome: 'selected', optionId } };
}

describe('acpPermissionOutcome', () => {
  it('answers one request with the single-use option even when a persistent kind is listed first', () => {
    expect(acpPermissionOutcome('approved', GROK_1_0_70_BASH)).toEqual(selected('allow-once'));
    expect(acpPermissionOutcome('denied', GROK_1_0_70_BASH)).toEqual(selected('reject-once'));
  });

  it('keeps the two-option list behavior', () => {
    expect(acpPermissionOutcome('approved', GROK_TWO_OPTION)).toEqual(selected('allow-once'));
    expect(acpPermissionOutcome('denied', GROK_TWO_OPTION)).toEqual(selected('reject-once'));
  });

  it('falls back to the persistent kind only when no single-use kind exists', () => {
    const alwaysOnly: PermissionOption[] = [
      { optionId: 'always-allow', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject-always', name: 'Never', kind: 'reject_always' },
    ];
    expect(acpPermissionOutcome('approved', alwaysOnly)).toEqual(selected('always-allow'));
    expect(acpPermissionOutcome('denied', alwaysOnly)).toEqual(selected('reject-always'));
  });

  it('cancels when no option matches the decision', () => {
    const allowOnly = GROK_TWO_OPTION.slice(0, 1);
    expect(acpPermissionOutcome('denied', allowOnly)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(acpPermissionOutcome('approved', [])).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('AcpApprovalService', () => {
  const request = {
    sessionId: 'session-1',
    toolCall: { toolCallId: 'call-1', title: 'Run Command', kind: 'execute' as const, rawInput: { variant: 'Bash' } },
    options: GROK_1_0_70_BASH,
  };

  it('selects allow_once for a host approval of the 1.0.70 four-option list', async () => {
    const published: string[] = [];
    const service = new AcpApprovalService({
      decide: () => 'approved',
      publish: (event) => published.push(event.type),
    });
    await expect(service.handle(request)).resolves.toEqual(selected('allow-once'));
    expect(published).toEqual(['interaction:permission-requested', 'interaction:permission-resolved']);
  });

  it('still denies with the single-use reject when no host decision callback exists', async () => {
    // The no-handler policy is unchanged: deny the one request, never persist a rule.
    const service = new AcpApprovalService({ publish: () => undefined });
    await expect(service.handle(request)).resolves.toEqual(selected('reject-once'));
  });
});

describe('AcpApprovalService unhandled-approval policy', () => {
  const request = {
    sessionId: 'session-1',
    toolCall: { toolCallId: 'call-1', title: 'Run Command', kind: 'execute' as const, rawInput: { variant: 'Bash' } },
    options: GROK_1_0_70_BASH,
  };
  const update = (status: string, extra: Record<string, unknown> = {}) => ({
    sessionId: 'session-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status, ...extra },
  });

  function recording() {
    const published: { type: string; outcome?: string; presentation?: string }[] = [];
    const publish = (event: { type: string }) => published.push(event as (typeof published)[number]);
    return { published, publish };
  }

  it('denies at once by default and labels the request host-ui', async () => {
    const { published, publish } = recording();
    const service = new AcpApprovalService({ publish });
    await expect(service.handle(request)).resolves.toEqual(selected('reject-once'));
    expect(published).toEqual([
      expect.objectContaining({ type: 'interaction:permission-requested', presentation: 'host-ui' }),
      expect.objectContaining({ type: 'interaction:permission-resolved', outcome: 'denied' }),
    ]);
    expect(service.pendingCount).toBe(0);
  });

  it('lets a host handler decide even when the composition defers', async () => {
    const { published, publish } = recording();
    const service = new AcpApprovalService({ decide: () => 'approved', unhandled: 'defer', publish });
    await expect(service.handle(request)).resolves.toEqual(selected('allow-once'));
    expect(published.map(({ presentation, outcome }) => presentation ?? outcome)).toEqual(['host-ui', 'allowed']);
  });

  it('defers to the native TUI and settles allowed from ACP tool progress', async () => {
    const { published, publish } = recording();
    const service = new AcpApprovalService({ unhandled: 'defer', publish });
    let answered: unknown;
    const pending = service.handle(request).then((response) => (answered = response));
    await Promise.resolve();
    expect(published).toEqual([
      expect.objectContaining({ type: 'interaction:permission-requested', presentation: 'native-tui' }),
    ]);
    expect(answered).toBeUndefined();
    expect(service.pendingCount).toBe(1);

    // A status-less update (Grok sends one before the request) proves nothing.
    service.observe('session/update', update(undefined as unknown as string));
    service.observe('session/update', { ...update('in_progress'), sessionId: 'other-session' });
    expect(service.pendingCount).toBe(1);

    service.observe('session/update', update('in_progress'));
    await pending;
    expect(published.at(-1)).toEqual({
      type: 'interaction:permission-resolved',
      requestId: 'call-1',
      outcome: 'allowed',
    });
    // The late reply only releases the SDK request; it is never a decision.
    expect(answered).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(service.pendingCount).toBe(0);
    service.observe('session/update', update('completed'));
    expect(published.filter(({ type }) => type === 'interaction:permission-resolved')).toHaveLength(1);
  });

  it('settles from agent evidence, per tool call or for a whole session', async () => {
    const { published, publish } = recording();
    const service = new AcpApprovalService({
      unhandled: 'defer',
      deferredEvidence: (method, params) => {
        const update = params.update as Record<string, unknown> | undefined;
        if (method === 'session/update' && update?.status === 'failed') {
          return [{ toolCallId: update.toolCallId as string, outcome: 'denied' }];
        }
        return method === '_x.ai/turn_end' ? [{ outcome: 'dismissed' }] : [];
      },
      publish,
    });
    const first = service.handle(request);
    const second = service.handle({ ...request, toolCall: { ...request.toolCall, toolCallId: 'call-2' } });
    const foreign = service.handle({ ...request, sessionId: 'session-2' });
    expect(service.pendingCount).toBe(3);

    service.observe('session/update', update('failed'));
    await expect(first).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    service.observe('_x.ai/turn_end', { sessionId: 'session-1' });
    await expect(second).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(service.pendingCount).toBe(1);
    expect(
      published.flatMap((event) => (event.type === 'interaction:permission-resolved' ? [event.outcome] : [])),
    ).toEqual(['denied', 'dismissed']);

    service.settleAll('unknown', { lifecycle: 'dispose' });
    await expect(foreign).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(service.pendingCount).toBe(0);
  });

  it('supersedes a repeated request for a tool call that is still pending', async () => {
    const { published, publish } = recording();
    const service = new AcpApprovalService({ unhandled: 'defer', publish });
    const first = service.handle(request);
    const second = service.handle(request);
    await expect(first).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(service.pendingCount).toBe(1);
    service.settleAll('unknown', {}, 'session-1');
    await expect(second).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(
      published.flatMap((event) => (event.type === 'interaction:permission-resolved' ? [event.outcome] : [])),
    ).toEqual(['unknown', 'unknown']);
  });
});
