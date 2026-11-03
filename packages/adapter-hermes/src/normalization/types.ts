import type { AgentEvent, AgentEventConfidence, AgentEventSource } from '@vibefield/puppeteer-core';

export type HermesNormalizationDisposition = 'mapped' | 'retained-native' | 'buffered' | 'no-output';

export interface HermesNormalizedRecord {
  events: AgentEvent[];
  nativeSessionId?: string | undefined;
  liveSessionId?: string | undefined;
  turnId?: string | undefined;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  nativeEvent: unknown;
  disposition: HermesNormalizationDisposition;
}

export interface HermesGatewayEvent {
  type?: unknown;
  session_id?: unknown;
  payload?: unknown;
  [key: string]: unknown;
}

export const MAX_HERMES_CORRELATIONS = 1_024;

export const hermesRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export const hermesString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export function boundedHermesMapSet<K, V>(target: Map<K, V>, key: K, value: V): void {
  if (!target.has(key) && target.size >= MAX_HERMES_CORRELATIONS) {
    const oldest = target.keys().next().value as K | undefined;
    if (oldest !== undefined) target.delete(oldest);
  }
  target.set(key, value);
}

export function parseHermesFrame(frame: unknown): {
  type?: string | undefined;
  /** A server→client JSON-RPC request (0.21+ approvals, clarify, ...): its id and method. */
  serverRequest?: { id: string; method: string } | undefined;
  liveSessionId?: string | undefined;
  payload: Record<string, unknown>;
} {
  const body = hermesRecord(frame);
  if (!body) return { payload: {} };
  const request = hermesServerRequest(body);
  if (request) {
    return {
      serverRequest: { id: request.id, method: request.method },
      liveSessionId: hermesString(request.params.session_id),
      payload: request.params,
    };
  }
  if (body.method === 'event') {
    const params = hermesRecord(body.params);
    return {
      type: hermesString(params?.type),
      liveSessionId: hermesString(params?.session_id),
      payload: hermesRecord(params?.payload) ?? {},
    };
  }
  return {
    type: hermesString(body.type),
    liveSessionId: hermesString(body.session_id),
    payload: hermesRecord(body.payload) ?? {},
  };
}

/**
 * From 0.21 the gateway asks its clients questions as JSON-RPC requests of its own: a method other
 * than `event`, an `srq-` string id, and params carrying `session_id`. Every attached client receives
 * one and the first response settles it, so Puppeteer observes these and never answers them.
 */
export function hermesServerRequest(
  frame: unknown,
): { id: string; method: string; params: Record<string, unknown> } | undefined {
  const body = hermesRecord(frame);
  if (!body || typeof body.method !== 'string' || body.method === 'event') return undefined;
  if (typeof body.id !== 'string' && typeof body.id !== 'number') return undefined;
  return { id: String(body.id), method: body.method, params: hermesRecord(body.params) ?? {} };
}

export function hermesNativeEvent(nativeType: string): AgentEvent {
  return { type: 'adapter:native-event', adapter: 'hermes', nativeType };
}
