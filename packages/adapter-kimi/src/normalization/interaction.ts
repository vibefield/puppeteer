import type { AgentEvent } from '@vibecook/puppeteer-core';
import { boundedKimiMapSet, kimiRecord, kimiString } from './types.js';

interface InteractionFact {
  kind: string;
}

function permissionOutcome(response: unknown): 'allowed' | 'denied' | 'dismissed' | 'unknown' {
  const body = kimiRecord(response);
  if (body?.cancelled === true) return 'dismissed';
  const decision = (kimiString(body?.decision) ?? kimiString(body?.outcome) ?? kimiString(response))?.toLowerCase();
  if (decision && ['approved', 'approve', 'allowed', 'allow', 'yes'].includes(decision)) return 'allowed';
  if (decision && ['denied', 'deny', 'rejected', 'reject', 'no'].includes(decision)) return 'denied';
  if (decision && ['dismissed', 'cancelled', 'canceled'].includes(decision)) return 'dismissed';
  return 'unknown';
}

/** Kimi interaction request/resolution → permission lifecycle events. */
export class KimiInteractionNormalizer {
  private readonly interactions = new Map<string, InteractionFact>();

  request(body: Record<string, unknown>): AgentEvent[] | undefined {
    const requestId = kimiString(body.id);
    const kind = kimiString(body.kind) ?? 'unknown';
    if (!requestId) return undefined;
    boundedKimiMapSet(this.interactions, requestId, { kind });
    if (kind !== 'approval') return undefined;
    const request = kimiRecord(body.request);
    const tool = kimiString(request?.tool) ?? kimiString(request?.toolName);
    const toolCallId = kimiString(body.toolCallId);
    return [
      {
        type: 'interaction:permission-requested',
        requestId,
        ...(toolCallId ? { toolCallId } : {}),
        ...(tool ? { tool } : {}),
        ...(request?.input !== undefined ? { input: request.input } : {}),
        presentation: 'native-tui',
      },
    ];
  }

  resolve(body: Record<string, unknown>): AgentEvent[] | undefined {
    const requestId = kimiString(body.id);
    const fact = requestId ? this.interactions.get(requestId) : undefined;
    if (!requestId || fact?.kind !== 'approval') return undefined;
    this.interactions.delete(requestId);
    return [{ type: 'interaction:permission-resolved', requestId, outcome: permissionOutcome(body.response) }];
  }
}
