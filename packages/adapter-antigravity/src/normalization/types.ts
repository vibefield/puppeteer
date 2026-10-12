import type {
  AgentEvent,
  AgentEventConfidence,
  AgentEventSource,
  AgentEventSourceRef,
} from '@vibefield/puppeteer-core';
export interface AntigravityNormalizedRecord {
  events: AgentEvent[];
  promptId?: string | undefined;
  turnId?: string | undefined;
  timestamp?: string | undefined;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  nativeEvent: unknown;
  disposition: 'mapped' | 'retained-native' | 'no-output';
}
export interface AntigravityObservedMeta {
  cursorStart: number;
  cursorEnd: number;
  sourceGeneration: number;
  replay: boolean;
}
export const antigravityRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export const antigravityString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
export function antigravityStep(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : antigravityString(value);
}
export function antigravityNativeEvent(type: string): AgentEvent {
  return { type: 'adapter:native-event', adapter: 'antigravity', nativeType: type };
}
export function antigravityErrorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const body = antigravityRecord(value);
  const direct = antigravityString(body?.message) ?? antigravityString(body?.error) ?? antigravityString(body?.content);
  if (direct) return direct;
  try {
    return value === undefined ? undefined : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
export function antigravityPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u.exec(value)?.[1] ?? value;
}
export function antigravitySourceRef(
  sessionId: string,
  meta: AntigravityObservedMeta,
  projection: string,
): AgentEventSourceRef {
  return {
    namespace: 'antigravity:transcript',
    eventId: `${sessionId}:${meta.sourceGeneration}:${meta.cursorStart}-${meta.cursorEnd}:${projection}`,
    revisionKey: `${meta.sourceGeneration}:${meta.cursorStart}-${meta.cursorEnd}`,
    sourceGeneration: meta.sourceGeneration,
    cursorStart: meta.cursorStart,
    cursorEnd: meta.cursorEnd,
  };
}
