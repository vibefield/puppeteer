import type { AcpDeferredApprovalSettlement } from '@vibefield/puppeteer-adapter-acp';

type Params = Record<string, unknown>;

function record(value: unknown): Params | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Params) : undefined;
}

/**
 * Grok's own evidence for a leader-routed permission request the controller
 * left to the native viewer (1.0.70 approval probe,
 * packages/surface/vendors/grok/probes/grok@1.0.70/viewer-approvals.json).
 *
 * The leader never tells the controller who answered or how: there is no
 * `$/cancel_request`, and `interaction_resolved {tool_call_id}` carries no
 * outcome. The outcome is the tool call's own next update — `in_progress` or
 * `completed` when allowed (ACP's generic rule in adapter-acp covers that), and
 * `failed` with `_meta.toolNotRun` `rejected` (a reject) or `cancelled` (the
 * viewer prompt cancelled) — or, for a request withdrawn by the turn itself
 * (a controller's cancel produces no tool update), the turn's cancellation
 * category.
 *
 * Only the live `_x.ai/session_notification` spelling is read; replayed history
 * (`_meta.isReplay`) never settles a live request.
 */
export function grokDeferredApprovalEvidence(method: string, params: Params): AcpDeferredApprovalSettlement[] {
  if (record(params._meta)?.isReplay === true) return [];
  const update = record(params.update);
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
  if (!update || !sessionId) return [];

  if (method === 'session/update' && update.sessionUpdate === 'tool_call_update' && update.status === 'failed') {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
    const notRun = record(update._meta)?.toolNotRun;
    if (!toolCallId) return [];
    if (notRun === 'rejected') return [{ sessionId, toolCallId, outcome: 'denied' }];
    if (notRun === 'cancelled') return [{ sessionId, toolCallId, outcome: 'dismissed' }];
    return [];
  }

  if (method === '_x.ai/session_notification' && update.sessionUpdate === 'turn_completed') {
    // Requests still open at the turn's end had no tool update. A turn ended by
    // a rejection or a cancelled prompt names it; a mid-turn abort withdrew the
    // request without anyone deciding. Anything else is not evidence of either.
    const category = record(params._meta)?.cancellationCategory;
    const outcome =
      category === 'PermissionRejected'
        ? 'denied'
        : category === 'PermissionCancelled' || category === 'MidTurnAbort'
          ? 'dismissed'
          : 'unknown';
    return [{ sessionId, outcome }];
  }
  return [];
}
