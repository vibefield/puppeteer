/**
 * Server-request responses, per the vendor's own generated schema
 * (`codex app-server generate-json-schema`, reverified against codex-cli
 * 0.150.0 by the pinned hermetic approval census on 2026-08-27).
 *
 * `CodexApprovalDecision` ('approved' | 'denied') stays the ABSTRACT contract
 * callers program against. What changed is that it is no longer written to the
 * wire verbatim: codex has four different response shapes across its eleven
 * server requests, and the abstract word is valid in almost none of them.
 *
 *   'approved' is legal on 2 of 11 — the deprecated `execCommandApproval` /
 *   `applyPatchApproval` pair, via `ReviewDecision`.
 *   'denied' is legal on ZERO. The legacy pair spells denial as the OBJECT
 *   `{denied:{rejection}}`; the current pair spells it `"decline"`.
 *
 * Since the default with no `onApproval` handler is to deny, the adapter's
 * out-of-the-box answer to any approval was malformed on every method. It was
 * never caught because the one captured session used `approvalPolicy:'never'`,
 * so no approval ever arrived — the gap was marked UNVERIFIED in driver.ts and
 * is settled here.
 *
 * Who answers is the second half. Codex sends a thread's server requests to
 * every connection subscribed to the thread, through the same thread-scoped
 * sender as its notifications, replays the open ones to a connection that joins
 * later, and acts on the first reply from any of them (codex-rs/app-server
 * `outgoing_message.rs` `send_request_to_connections` and
 * `take_connection_callback`, `request_processors/thread_lifecycle.rs`,
 * rust-v0.164.0). Where Codex's own TUI is one of those connections, it shows
 * the person each approval and prompt it is sent and replies with their choice
 * (codex-rs/tui `app/app_server_requests.rs`), and it closes the prompt when
 * `serverRequest/resolved` says another client answered first
 * (`app/app_server_events.rs`). A reply from this client would answer for them.
 */

import type { InteractionEvent, PermissionResolvedEvent } from '@vibefield/puppeteer-core';
import { NO_REPLY } from '../transport/app-server-client.js';

export type CodexApprovalDecision = 'approved' | 'denied';

export interface CodexApprovalRequest {
  method: string;
  params: Record<string, unknown> | undefined;
  requestId: number | string;
  /**
   * Present only where Codex's own TUI is shown the same request
   * (`unhandled: 'defer'`). Aborted once the request settled without this
   * decision — the person answered in the TUI, the turn ended, the connection
   * closed, or the session was disposed — so a host UI can close. A decision
   * returned after the abort is dropped, never sent.
   */
  signal?: AbortSignal | undefined;
}

/**
 * What answers a person-facing request when the host supplied no decision handler.
 *
 * - `deny` (the default): this client refuses it at once. Right only where it is
 *   the app-server's sole client (the headless driver); leaving the request open
 *   there would hang the turn.
 * - `defer`: this client never replies. For a composition in which Codex's own
 *   TUI is attached to the same thread on the same app-server: the TUI is sent
 *   the same request and asks the person. The request settles from Codex's
 *   `serverRequest/resolved`, which carries no decision.
 *
 * `defer` also declares the request shared, so a host decision races the
 * person: a resolution that arrives before `decide` returns settles the
 * request, aborts the host's `signal`, and the later decision is dropped. A
 * host decides only the approvals; the TUI's other prompts stay the person's.
 */
export type CodexUnhandledApprovalPolicy = 'deny' | 'defer';

/**
 * Legacy pair answering with `ReviewDecision`. Deprecated upstream but still
 * present in 0.150.0, and still what an older app-server sends.
 */
const REVIEW_DECISION_METHODS = new Set(['execCommandApproval', 'applyPatchApproval']);

/** Current approval pair answering with an accept/decline decision. */
const ACCEPT_DECLINE_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);

/**
 * Server requests that are NOT approvals: they ask the client to supply a
 * capability (an attestation token, refreshed auth tokens, tool output, user
 * input). Answering them with an approval decision produces a well-formed
 * JSON-RPC response carrying a body the server cannot parse — worse than an
 * error, because it looks like success. The adapter does not implement these,
 * so it must say so (see `approvalResponse` throwing).
 */
const CAPABILITY_METHODS = new Set([
  'item/tool/call',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
  'attestation/generate',
  'account/chatgptAuthTokens/refresh',
  'currentTime/read',
]);

/**
 * Requests a person answers: the approvals, and the prompts Codex's TUI holds
 * for the person (codex-rs/tui `app/pending_interactive_replay.rs`,
 * rust-v0.164.0: request-permissions, request_user_input and MCP
 * elicitations). The app-server sends each through the thread-scoped sender
 * (`bespoke_event_handling.rs`), so every subscribed connection receives it.
 * The remaining capability requests are the client's to supply, not the
 * person's, and keep their error answer.
 */
const PERSON_FACING_METHODS = new Set([
  ...REVIEW_DECISION_METHODS,
  ...ACCEPT_DECLINE_METHODS,
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

/** The tool an approval gates, named as `normalization/tool.ts` names the item it runs. */
const APPROVED_TOOLS: ReadonlyMap<string, string> = new Map([
  ['execCommandApproval', 'command'],
  ['item/commandExecution/requestApproval', 'command'],
  ['applyPatchApproval', 'apply_patch'],
  ['item/fileChange/requestApproval', 'apply_patch'],
]);

export function isApprovalRequest(method: string): boolean {
  return REVIEW_DECISION_METHODS.has(method) || ACCEPT_DECLINE_METHODS.has(method);
}

export class UnsupportedServerRequestError extends Error {
  constructor(method: string) {
    super(
      `codex server request ${method} is not implemented by this client; ` +
        `answering it with an approval decision would send an unparseable body`,
    );
    this.name = 'UnsupportedServerRequestError';
  }
}

/**
 * Translate the abstract decision into the exact body this method expects.
 * Throws for anything that is not an approval, so the transport answers with a
 * JSON-RPC error rather than a plausible-looking wrong result.
 */
export function approvalResponse(
  method: string,
  decision: CodexApprovalDecision,
  rejection = 'denied by puppeteer policy',
): Record<string, unknown> {
  if (REVIEW_DECISION_METHODS.has(method)) {
    return decision === 'approved' ? { decision: 'approved' } : { decision: { denied: { rejection } } };
  }
  if (ACCEPT_DECLINE_METHODS.has(method)) {
    return { decision: decision === 'approved' ? 'accept' : 'decline' };
  }
  throw new UnsupportedServerRequestError(method);
}

/** Every server request the schema declares, for tests and diagnostics. */
export const KNOWN_SERVER_REQUESTS: readonly string[] = [
  ...REVIEW_DECISION_METHODS,
  ...ACCEPT_DECLINE_METHODS,
  ...CAPABILITY_METHODS,
];

export interface CodexApprovalServiceOptions {
  decide?: ((request: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>) | undefined;
  /**
   * Who answers a person-facing request `decide` does not. With `decide`, `defer`
   * still marks an approval shared. Default `deny`.
   */
  unhandled?: CodexUnhandledApprovalPolicy | undefined;
  publish(event: InteractionEvent, nativeEvent: unknown): void;
  isDisposed(): boolean;
}

/**
 * A shared request this client has not answered: deferred to the TUI, or
 * awaiting a host decision that races the person.
 */
interface PendingApproval {
  /** The host decision still outstanding, aborted when the request settles without it. */
  readonly host?: AbortController | undefined;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** Adapts Codex server requests to the Core permission service contract. */
export class CodexApprovalService {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly options: CodexApprovalServiceOptions) {}

  /** Shared requests still awaiting Codex's resolution; bounded by it, the connection's close, and dispose. */
  get pendingCount(): number {
    return this.pending.size;
  }

  async handle(
    method: string,
    params: Record<string, unknown> | undefined,
    id: number | string,
  ): Promise<Record<string, unknown> | typeof NO_REPLY> {
    if (this.options.isDisposed()) throw new Error('codex session is disposed');
    const requestId = String(id);
    const nativeEvent = { method, params, id };
    // Codex's own TUI is sent this request too, and Codex acts on the first reply.
    const shared = this.options.unhandled === 'defer' && PERSON_FACING_METHODS.has(method);
    // An approve/deny decision answers an approval only. A shared prompt of any
    // other kind is the person's: an error reply would refuse it for them.
    const decide = shared && !isApprovalRequest(method) ? undefined : this.options.decide;
    const toolCallId = nonEmpty(params?.itemId);
    this.options.publish(
      {
        type: 'interaction:permission-requested',
        requestId,
        ...(toolCallId ? { toolCallId } : {}),
        tool: APPROVED_TOOLS.get(method) ?? method,
        input: params,
        presentation: !decide && shared ? 'native-tui' : 'host-ui',
      },
      nativeEvent,
    );
    if (!decide) {
      if (!shared) return this.resolve(method, requestId, 'denied', nativeEvent);
      this.pending.set(requestId, {});
      return NO_REPLY;
    }
    const request: CodexApprovalRequest = { method, params, requestId: id };
    if (!shared) return this.resolve(method, requestId, await decide(request), nativeEvent);

    // Shared: the first of the host decision and the person's answer in the TUI
    // wins. When the person's wins, Codex already acted on it; the host decision
    // is dropped rather than sent or published.
    const host = new AbortController();
    const entry: PendingApproval = { host };
    this.pending.set(requestId, entry);
    let decision: CodexApprovalDecision;
    try {
      decision = await decide({ ...request, signal: host.signal });
    } catch {
      // A host that could not decide leaves the request to the person, who is
      // still asked in the TUI. An error reply would be Codex's refusal
      // ("approval request failed"); the entry settles from its resolution.
      return NO_REPLY;
    }
    if (this.pending.get(requestId) !== entry) return NO_REPLY;
    this.pending.delete(requestId);
    return this.resolve(method, requestId, decision, nativeEvent);
  }

  /**
   * Read one live notification as evidence for shared requests. Codex sends
   * `serverRequest/resolved` to every subscribed connection once any client
   * answered a request, and when a turn's start, completion or interruption
   * cleared it unanswered (`request_processors/thread_lifecycle.rs`; each
   * request handler in `bespoke_event_handling.rs` sends it as the reply
   * arrives, before acting on it, rust-v0.164.0). It names the request, not
   * the decision.
   */
  observe(method: string, params: Record<string, unknown>): void {
    if (this.pending.size === 0 || method !== 'serverRequest/resolved') return;
    const id = params.requestId;
    if (typeof id === 'string' || typeof id === 'number') this.settleOne(String(id), 'unknown', { method, params });
  }

  /**
   * Settle every shared request without Codex's word on it: the connection
   * closed or the session is being disposed, so no resolution can arrive.
   */
  settleAll(outcome: PermissionResolvedEvent['outcome'], nativeEvent: unknown): void {
    for (const requestId of [...this.pending.keys()]) this.settleOne(requestId, outcome, nativeEvent);
  }

  private resolve(
    method: string,
    requestId: string,
    decision: CodexApprovalDecision,
    nativeEvent: unknown,
  ): Record<string, unknown> {
    this.options.publish(
      { type: 'interaction:permission-resolved', requestId, outcome: decision === 'approved' ? 'allowed' : 'denied' },
      nativeEvent,
    );
    // Per-method response shape; throws for a request that is not an approval.
    return approvalResponse(method, decision);
  }

  private settleOne(requestId: string, outcome: PermissionResolvedEvent['outcome'], nativeEvent: unknown): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    this.options.publish({ type: 'interaction:permission-resolved', requestId, outcome }, nativeEvent);
    entry.host?.abort();
  }
}
