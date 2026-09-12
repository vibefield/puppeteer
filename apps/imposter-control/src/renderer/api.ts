import type { ApiError, SessionView } from './types.js';

function controlToken(): string {
  const token = document.querySelector<HTMLMetaElement>('meta[name="control-token"]')?.content;
  if (!token || token === '{TOKEN}') throw new Error('control-plane token is missing from the console document');
  return token;
}

export type ApiResponse<T extends object> = T & Partial<ApiError>;

export async function api<T extends object>(path: string, body?: object): Promise<ApiResponse<T>> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${controlToken()}`,
    },
    // `RequestInit` is lib.dom's, so it distinguishes an absent `body` from an
    // explicit `undefined`; omit the key entirely for the GET shape.
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as ApiResponse<T>;
}

export function eventStreamUrl(): string {
  return `/api/events?token=${encodeURIComponent(controlToken())}`;
}

export function sessionApi(
  session: Pick<SessionView, 'vendor' | 'sessionId'>,
  action: 'trigger' | 'op' | 'scenario' | 'scenario-control' | 'fault' | 'log',
): string {
  return `/api/sessions/${encodeURIComponent(session.sessionId)}/${action}?vendor=${encodeURIComponent(session.vendor)}`;
}

export function projectionApi(session: Pick<SessionView, 'vendor' | 'sessionId'>, projection: string): string {
  return `/api/sessions/${encodeURIComponent(session.sessionId)}/projections/${encodeURIComponent(projection)}?vendor=${encodeURIComponent(session.vendor)}`;
}
