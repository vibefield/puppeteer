import { describe, expect, it } from 'vitest';
import { grokDeferredApprovalEvidence } from './interaction.js';

const SESSION = 'grok-session';

// Shapes from the 1.0.70 approval probe
// (packages/surface/vendors/grok/probes/grok@1.0.70/viewer-approvals.json).
const toolUpdate = (status: string | undefined, meta?: Record<string, unknown>) => ({
  sessionId: SESSION,
  update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    ...(status ? { status } : {}),
    ...(meta ? { _meta: meta } : {}),
  },
});
const turnCompleted = (stopReason: string, cancellationCategory?: string) => ({
  sessionId: SESSION,
  update: { sessionUpdate: 'turn_completed', prompt_id: 'prompt-1', stop_reason: stopReason },
  _meta: { eventId: `${SESSION}-9`, ...(cancellationCategory ? { cancellationCategory } : {}) },
});

describe('grokDeferredApprovalEvidence', () => {
  it('reads a reject and a cancelled viewer prompt from the tool call that never ran', () => {
    expect(grokDeferredApprovalEvidence('session/update', toolUpdate('failed', { toolNotRun: 'rejected' }))).toEqual([
      { sessionId: SESSION, toolCallId: 'call-1', outcome: 'denied' },
    ]);
    expect(grokDeferredApprovalEvidence('session/update', toolUpdate('failed', { toolNotRun: 'cancelled' }))).toEqual([
      { sessionId: SESSION, toolCallId: 'call-1', outcome: 'dismissed' },
    ]);
  });

  it('leaves allowed tool progress to the generic ACP rule and ignores updates that prove nothing', () => {
    for (const params of [
      toolUpdate('in_progress'),
      toolUpdate('completed'),
      toolUpdate(undefined),
      toolUpdate('failed'),
      toolUpdate('failed', { toolNotRun: 'something-new' }),
    ]) {
      expect(grokDeferredApprovalEvidence('session/update', params)).toEqual([]);
    }
  });

  it('settles requests still open at the turn end from its cancellation category', () => {
    const outcome = (params: Record<string, unknown>) =>
      grokDeferredApprovalEvidence('_x.ai/session_notification', params).map((entry) => entry.outcome);
    expect(outcome(turnCompleted('cancelled', 'MidTurnAbort'))).toEqual(['dismissed']);
    expect(outcome(turnCompleted('cancelled', 'PermissionCancelled'))).toEqual(['dismissed']);
    expect(outcome(turnCompleted('cancelled', 'PermissionRejected'))).toEqual(['denied']);
    expect(outcome(turnCompleted('end_turn'))).toEqual(['unknown']);
    expect(grokDeferredApprovalEvidence('_x.ai/session_notification', turnCompleted('end_turn'))[0]).toEqual({
      sessionId: SESSION,
      outcome: 'unknown',
    });
  });

  it('never settles a live request from replayed history or the durable spelling', () => {
    expect(
      grokDeferredApprovalEvidence('session/update', {
        ...toolUpdate('failed', { toolNotRun: 'rejected' }),
        _meta: { isReplay: true },
      }),
    ).toEqual([]);
    expect(grokDeferredApprovalEvidence('_x.ai/session/update', turnCompleted('cancelled', 'MidTurnAbort'))).toEqual(
      [],
    );
    expect(
      grokDeferredApprovalEvidence('_x.ai/session_notification', {
        sessionId: SESSION,
        update: { sessionUpdate: 'interaction_resolved', tool_call_id: 'call-1' },
      }),
    ).toEqual([]);
  });
});
