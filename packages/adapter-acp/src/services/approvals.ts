import type { AgentEvent } from '@vibecook/puppeteer-core';
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export type AcpApprovalDecision = 'approved' | 'denied';

export interface AcpApprovalRequest {
  toolCallId: string;
  tool?: string;
  input?: unknown;
  options: PermissionOption[];
}

export interface AcpApprovalServiceOptions {
  decide?: (request: AcpApprovalRequest) => AcpApprovalDecision | Promise<AcpApprovalDecision>;
  publish(event: AgentEvent, nativeEvent: unknown): void;
}

/** Pick the ACP permission option matching an approve/deny decision. */
export function acpPermissionOutcome(
  decision: AcpApprovalDecision,
  options: PermissionOption[],
): RequestPermissionResponse {
  const prefix = decision === 'approved' ? 'allow' : 'reject';
  const chosen = options.find((option) => option.kind.startsWith(prefix));
  return chosen
    ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/** Structured ACP permission request → normalized permission events + response. */
export class AcpApprovalService {
  constructor(private readonly options: AcpApprovalServiceOptions) {}

  async handle(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = params.toolCall.toolCallId;
    const tool = params.toolCall.title ?? params.toolCall.kind ?? undefined;
    this.options.publish(
      {
        type: 'interaction:permission-requested',
        requestId,
        toolCallId: requestId,
        tool,
        input: params.toolCall.rawInput,
        presentation: 'host-ui',
      },
      params,
    );
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
}
