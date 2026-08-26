/** Durable OpenCode REST state projected through the same native normalizer. */

import { createHash } from 'node:crypto';
import type {
  OpenCodeMessage,
  OpenCodePermissionRequest,
  OpenCodeQuestionRequest,
  OpenCodeSessionInfo,
} from '../transport/client.js';
import type { OpenCodeSseRecord } from '../transport/event-stream.js';

export interface OpenCodeHistoryProjection {
  record: OpenCodeSseRecord;
  /** The actual durable HTTP entity retained on normalized envelopes. */
  nativeEvent: unknown;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function projectedID(kind: string, id: unknown, value: unknown): string {
  return `history:${kind}:${typeof id === 'string' ? id : 'unknown'}:${fingerprint(value)}`;
}

/**
 * `GET /session/:id/message` returns the same `info` and `part` shapes carried
 * by live `message.updated` / `message.part.updated` events. Projecting those
 * shapes closes SSE gaps without claiming that SSE itself replayed anything.
 */
export function projectOpenCodeHistory(messages: readonly OpenCodeMessage[]): OpenCodeHistoryProjection[] {
  const projected: OpenCodeHistoryProjection[] = [];
  for (const message of messages) {
    const info = message.info;
    const nativeEvent = { type: 'http/session.messages', message };
    projected.push({
      record: {
        id: projectedID('message', info.id, info),
        type: 'message.updated',
        properties: { sessionID: info.sessionID, info },
      },
      nativeEvent,
    });
    for (const part of message.parts) {
      projected.push({
        record: {
          id: projectedID('part', part.id, part),
          type: 'message.part.updated',
          properties: { sessionID: part.sessionID, part },
        },
        nativeEvent,
      });
    }
  }
  return projected;
}

export function projectOpenCodeChild(info: OpenCodeSessionInfo): OpenCodeHistoryProjection {
  return {
    record: {
      id: projectedID('child', info.id, info),
      type: 'session.created',
      properties: { sessionID: info.id, info },
    },
    nativeEvent: { type: 'http/session.children', body: info },
  };
}

export function projectOpenCodePermission(request: OpenCodePermissionRequest): OpenCodeHistoryProjection {
  return {
    record: {
      id: projectedID('permission', request.id, request),
      type: 'permission.asked',
      properties: { ...request },
    },
    nativeEvent: { type: 'http/permission.list', request },
  };
}

export function projectOpenCodeQuestion(request: OpenCodeQuestionRequest): OpenCodeHistoryProjection {
  return {
    record: {
      id: projectedID('question', request.id, request),
      type: 'question.asked',
      properties: { ...request },
    },
    nativeEvent: { type: 'http/question.list', request },
  };
}

export function projectOpenCodeStatus(
  sessionID: string,
  status: Record<string, unknown> | undefined,
): OpenCodeHistoryProjection {
  const durableStatus = status ?? { type: 'idle' };
  return {
    record: {
      id: projectedID('status', sessionID, durableStatus),
      type: 'session.status',
      properties: { sessionID, status: durableStatus },
    },
    nativeEvent: { type: 'http/session.status', sessionID, status: durableStatus },
  };
}
