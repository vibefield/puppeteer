import type { AgentEvent, PermissionResolvedEvent } from '@vibefield/puppeteer-core';
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export type AcpApprovalDecision = 'approved' | 'denied';

export interface AcpApprovalRequest {
  toolCallId: string;
  tool?: string | undefined;
  input?: unknown;
  options: PermissionOption[];
  /**
   * Present only where another attached client is shown the same request
   * (`unhandled: 'defer'`). Aborted once the request settled without this
   * decision — the agent acted on that client's answer, the turn ended, the
   * transport closed, or the session was disposed — so a host UI can close.
   * A decision returned after the abort is ignored.
   */
  signal?: AbortSignal | undefined;
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
 *
 * `defer` also declares that the agent acts on the FIRST answer from any
 * client, so a host decision races the person there too: native evidence that
 * arrives before `decide` resolves settles the request, aborts the host's
 * `signal`, and the later host decision is dropped rather than published.
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
  /** Without `decide`: who answers. With `decide`, `defer` still marks the request as shared. Default `deny`. */
  unhandled?: AcpUnhandledApprovalPolicy | undefined;
  /** With `unhandled: 'defer'`: the agent's native resolution evidence, for deferred and host-pending requests. */
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

/**
 * A request another attached client may answer: deferred (no host handler) or
 * host-pending in a shared composition. Native evidence settles either one;
 * a host decision settles only its own entry, and only while it is pending.
 */
interface PendingApproval {
  readonly requestId: string;
  readonly sessionId: string;
  /** The host decision still outstanding, aborted when the request settles without it. */
  readonly host?: AbortController | undefined;
  release(response: RequestPermissionResponse): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pendingKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}

/** Structured ACP permission request → normalized permission events + response. */
export class AcpApprovalService {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly options: AcpApprovalServiceOptions) {}

  /** Requests still awaiting native evidence or a shared host decision; bounded by turn end, transport close, and dispose. */
  get pendingCount(): number {
    return this.pending.size;
  }

  async handle(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = params.toolCall.toolCallId;
    const tool = params.toolCall.title ?? params.toolCall.kind ?? undefined;
    const decide = this.options.decide;
    // Another attached client is shown this request and the agent takes the first answer.
    const shared = this.options.unhandled === 'defer';
    // A repeated request for a tool call still pending supersedes the first;
    // nothing native says how the first one ended. It settles before the new
    // request is published: both carry the same requestId, so the reverse
    // order would resolve the new request in state while it is still open.
    this.settleOne(params.sessionId, requestId, 'unknown', params);
    this.options.publish(
      {
        type: 'interaction:permission-requested',
        requestId,
        toolCallId: requestId,
        tool,
        input: params.toolCall.rawInput,
        presentation: !decide && shared ? 'native-tui' : 'host-ui',
      },
      params,
    );
    if (!decide) {
      if (shared) return this.track(requestId, params.sessionId);
      return this.resolve(requestId, 'denied', params);
    }
    const request: AcpApprovalRequest = {
      toolCallId: requestId,
      tool,
      input: params.toolCall.rawInput,
      options: params.options,
    };
    if (!shared) return this.resolve(requestId, await decide(request), params);

    // Shared: the first of the host decision and native evidence wins. When the
    // evidence wins, the agent already acted on another client's answer; the
    // host decision is dropped and the SDK request only released.
    const key = pendingKey(params.sessionId, requestId);
    const host = new AbortController();
    const settled = this.track(requestId, params.sessionId, host);
    const entry = this.pending.get(key);
    const decided = Promise.resolve()
      .then(() => decide({ ...request, signal: host.signal }))
      .then(
        (decision) => {
          if (this.pending.get(key) !== entry) return settled;
          this.pending.delete(key);
          return this.resolve(requestId, decision, params);
        },
        (error: unknown) => {
          if (this.pending.get(key) !== entry) return settled;
          this.pending.delete(key);
          throw error;
        },
      );
    return Promise.race([settled, decided]);
  }

  /**
   * Read one inbound notification as evidence for pending requests. The
   * agent's own evidence is consulted first; ACP's tool-call progress (a tool
   * that started or completed was allowed) is the generic floor.
   */
  observe(method: string, params: Record<string, unknown>): void {
    if (this.pending.size === 0) return;
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
   * Settle every pending request, or those of one session, without native
   * evidence of the outcome: the prompt ended, the transport closed, or the
   * session is being disposed.
   */
  settleAll(outcome: AcpPermissionResolution, nativeEvent: unknown, sessionId?: string): void {
    for (const entry of [...this.pending.values()]) {
      if (sessionId === undefined || entry.sessionId === sessionId) {
        this.settleOne(entry.sessionId, entry.requestId, outcome, nativeEvent);
      }
    }
  }

  private resolve(
    requestId: string,
    decision: AcpApprovalDecision,
    params: RequestPermissionRequest,
  ): RequestPermissionResponse {
    this.options.publish(
      { type: 'interaction:permission-resolved', requestId, outcome: decision === 'approved' ? 'allowed' : 'denied' },
      params,
    );
    return acpPermissionOutcome(decision, params.options);
  }

  private track(requestId: string, sessionId: string, host?: AbortController): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>((release) => {
      this.pending.set(pendingKey(sessionId, requestId), { requestId, sessionId, host, release });
    });
  }

  private settleOne(sessionId: string, toolCallId: string, outcome: AcpPermissionResolution, nativeEvent: unknown) {
    const key = pendingKey(sessionId, toolCallId);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.options.publish({ type: 'interaction:permission-resolved', requestId: entry.requestId, outcome }, nativeEvent);
    entry.host?.abort();
    entry.release(RELEASED);
  }
}
