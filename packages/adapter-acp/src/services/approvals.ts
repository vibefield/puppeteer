import type { AgentEvent, PermissionResolvedEvent } from '@vibefield/puppeteer-core';
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export type AcpApprovalDecision = 'approved' | 'denied';

export interface AcpApprovalRequest {
  toolCallId: string;
  tool?: string | undefined;
  input?: unknown;
  options: PermissionOption[];
}

/**
 * What answers a permission request when the host supplied no decision handler.
 *
 * - `deny` (the default): this client answers at once with the single-use
 *   reject. Right whenever it is the only client the agent can ask; leaving the
 *   request open there would hang the turn.
 * - `defer`: this client does not answer. Only for a composition in which
 *   another client attached to the same agent session — the agent's own
 *   terminal UI — is shown the same request and lets a person answer it. The
 *   request then settles from native evidence (see `AcpDeferredApprovalEvidence`).
 */
export type AcpUnhandledApprovalPolicy = 'deny' | 'defer';

export type AcpPermissionResolution = PermissionResolvedEvent['outcome'];

/**
 * One deferred request settled by native evidence. Without `toolCallId` it
 * settles every deferred request of `sessionId` (the agent's own turn end).
 */
export interface AcpDeferredApprovalSettlement {
  sessionId?: string | undefined;
  toolCallId?: string | undefined;
  outcome: AcpPermissionResolution;
}

/**
 * Agent-specific reading of one inbound notification — `session/update` or an
 * extension method — as the outcome of a deferred request answered elsewhere.
 * ACP has no notification for "another client answered", so the generic rule
 * is limited to what the protocol itself proves: a tool call that starts or
 * completes was allowed. Every other outcome needs the agent's own evidence.
 */
export type AcpDeferredApprovalEvidence = (
  method: string,
  params: Record<string, unknown>,
) => readonly AcpDeferredApprovalSettlement[];

export interface AcpApprovalServiceOptions {
  decide?: ((request: AcpApprovalRequest) => AcpApprovalDecision | Promise<AcpApprovalDecision>) | undefined;
  /** Without `decide`. Default `deny`. */
  unhandled?: AcpUnhandledApprovalPolicy | undefined;
  /** With `unhandled: 'defer'`: the agent's native resolution evidence. */
  deferredEvidence?: AcpDeferredApprovalEvidence | undefined;
  publish(event: AgentEvent, nativeEvent: unknown): void;
}

/**
 * Pick the ACP permission option matching an approve/deny decision.
 *
 * A host decision answers one request, so the single-use kind wins regardless
 * of the agent's option order. Agents may list a persistent kind first (Grok
 * 1.0.70 offers `allow_always` ahead of `allow_once`); selecting it would write
 * a standing native rule and silently answer later requests the host is never
 * shown. A `*_always` kind is chosen only when no single-use kind is offered.
 */
export function acpPermissionOutcome(
  decision: AcpApprovalDecision,
  options: PermissionOption[],
): RequestPermissionResponse {
  const prefix = decision === 'approved' ? 'allow' : 'reject';
  const chosen =
    options.find((option) => option.kind === `${prefix}_once`) ??
    options.find((option) => option.kind === `${prefix}_always`) ??
    options.find((option) => typeof option.kind === 'string' && option.kind.startsWith(prefix));
  return chosen
    ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/**
 * The reply a deferring client finally sends, so the SDK's pending request does
 * not leak. It is never a decision: the agent already acted on the first answer
 * and ignores a later one, and a `cancelled` outcome cannot grant anything if
 * an agent ever did read it.
 */
const RELEASED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

interface DeferredApproval {
  readonly requestId: string;
  readonly sessionId: string;
  release(response: RequestPermissionResponse): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deferredKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}

/** Structured ACP permission request → normalized permission events + response. */
export class AcpApprovalService {
  private readonly deferred = new Map<string, DeferredApproval>();

  constructor(private readonly options: AcpApprovalServiceOptions) {}

  /** Deferred requests still awaiting native evidence; bounded by turn end, transport close, and dispose. */
  get pendingCount(): number {
    return this.deferred.size;
  }

  async handle(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = params.toolCall.toolCallId;
    const tool = params.toolCall.title ?? params.toolCall.kind ?? undefined;
    const deferring = !this.options.decide && this.options.unhandled === 'defer';
    this.options.publish(
      {
        type: 'interaction:permission-requested',
        requestId,
        toolCallId: requestId,
        tool,
        input: params.toolCall.rawInput,
        presentation: deferring ? 'native-tui' : 'host-ui',
      },
      params,
    );
    if (deferring) return this.defer(requestId, params);
    const decision = this.options.decide
      ? await this.options.decide({
          toolCallId: requestId,
          tool,
          input: params.toolCall.rawInput,
          options: params.options,
        })
      : 'denied';
    this.options.publish(
      { type: 'interaction:permission-resolved', requestId, outcome: decision === 'approved' ? 'allowed' : 'denied' },
      params,
    );
    return acpPermissionOutcome(decision, params.options);
  }

  /**
   * Read one inbound notification as evidence for deferred requests. The
   * agent's own evidence is consulted first; ACP's tool-call progress (a tool
   * that started or completed was allowed) is the generic floor.
   */
  observe(method: string, params: Record<string, unknown>): void {
    if (this.deferred.size === 0) return;
    const nativeEvent = { method, params };
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    for (const settlement of this.options.deferredEvidence?.(method, params) ?? []) {
      const session = settlement.sessionId ?? sessionId;
      if (settlement.toolCallId === undefined) this.settleAll(settlement.outcome, nativeEvent, session);
      else if (session !== undefined) this.settleOne(session, settlement.toolCallId, settlement.outcome, nativeEvent);
    }
    if (method !== 'session/update' || sessionId === undefined || !isRecord(params.update)) return;
    const update = params.update;
    if (
      update.sessionUpdate === 'tool_call_update' &&
      typeof update.toolCallId === 'string' &&
      (update.status === 'in_progress' || update.status === 'completed')
    ) {
      this.settleOne(sessionId, update.toolCallId, 'allowed', nativeEvent);
    }
  }

  /**
   * Settle every deferred request, or those of one session, without native
   * evidence of the outcome: the prompt ended, the transport closed, or the
   * session is being disposed.
   */
  settleAll(outcome: AcpPermissionResolution, nativeEvent: unknown, sessionId?: string): void {
    for (const entry of [...this.deferred.values()]) {
      if (sessionId === undefined || entry.sessionId === sessionId) {
        this.settleOne(entry.sessionId, entry.requestId, outcome, nativeEvent);
      }
    }
  }

  private defer(requestId: string, params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // A repeated request for a tool call still pending supersedes the first;
    // nothing native says how the first one ended.
    this.settleOne(params.sessionId, requestId, 'unknown', params);
    return new Promise<RequestPermissionResponse>((release) => {
      this.deferred.set(deferredKey(params.sessionId, requestId), {
        requestId,
        sessionId: params.sessionId,
        release,
      });
    });
  }

  private settleOne(sessionId: string, toolCallId: string, outcome: AcpPermissionResolution, nativeEvent: unknown) {
    const key = deferredKey(sessionId, toolCallId);
    const entry = this.deferred.get(key);
    if (!entry) return;
    this.deferred.delete(key);
    this.options.publish({ type: 'interaction:permission-resolved', requestId: entry.requestId, outcome }, nativeEvent);
    entry.release(RELEASED);
  }
}
