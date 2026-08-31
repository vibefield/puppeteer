import type { AgentEvent, AgentEventConfidence, AgentEventSource, AgentEventSourceRef } from '@vibecook/puppeteer-core';

export interface CopilotNormalizedRecord {
  events: AgentEvent[];
  promptId?: string;
  turnId?: string;
  agentId?: string;
  timestamp?: string;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  nativeEvent: unknown;
  disposition: 'mapped' | 'retained-native' | 'no-output';
}
export interface CopilotObservedMeta {
  cursorStart: number;
  cursorEnd: number;
  sourceGeneration: number;
  replay: boolean;
}
export const copilotRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export const copilotString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
export const copilotNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export function copilotNativeEvent(nativeType: string): AgentEvent {
  return { type: 'adapter:native-event', adapter: 'copilot', nativeType };
}
export function copilotErrorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const body = copilotRecord(value);
  const result = copilotString(body?.message) ?? copilotString(body?.error) ?? copilotString(body?.code);
  if (result) return result;
  try {
    return value === undefined ? undefined : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
export function copilotSourceRef(
  sessionId: string,
  meta: CopilotObservedMeta,
  projection: string,
): AgentEventSourceRef {
  return {
    namespace: 'copilot:session-events',
    eventId: `${sessionId}:${meta.sourceGeneration}:${meta.cursorStart}-${meta.cursorEnd}:${projection}`,
    revisionKey: `${meta.sourceGeneration}:${meta.cursorStart}-${meta.cursorEnd}`,
    sourceGeneration: meta.sourceGeneration,
    cursorStart: meta.cursorStart,
    cursorEnd: meta.cursorEnd,
  };
}
