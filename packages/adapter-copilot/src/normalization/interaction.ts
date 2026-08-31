import type { AgentEvent } from '@vibecook/puppeteer-core';
import { copilotRecord, copilotString } from './types.js';

export function normalizeCopilotInteraction(
  type: string,
  entryId: string,
  data: Record<string, unknown>,
): AgentEvent[] | undefined {
  if (type === 'permission.requested') {
    const requestId = copilotString(data.requestId) ?? entryId;
    const request = copilotRecord(data.permissionRequest) ?? copilotRecord(data.promptRequest) ?? {};
    const toolCallId = copilotString(request.toolCallId);
    const tool = copilotString(request.kind);
    return [
      {
        type: 'interaction:permission-requested',
        requestId,
        ...(toolCallId ? { toolCallId } : {}),
        ...(tool ? { tool } : {}),
        input: request,
        presentation: 'native-tui',
      },
    ];
  }
  if (type === 'permission.completed') {
    const requestId = copilotString(data.requestId);
    if (!requestId) return [];
    const result = copilotRecord(data.result);
    const raw = (
      copilotString(result?.kind) ??
      copilotString(copilotRecord(result?.approval)?.kind) ??
      ''
    ).toLowerCase();
    const outcome =
      raw.includes('den') || raw.includes('reject')
        ? 'denied'
        : raw.includes('allow') || raw.includes('approv')
          ? 'allowed'
          : raw.includes('dismiss') || raw.includes('cancel')
            ? 'dismissed'
            : 'unknown';
    return [{ type: 'interaction:permission-resolved', requestId, outcome }];
  }
  return undefined;
}
