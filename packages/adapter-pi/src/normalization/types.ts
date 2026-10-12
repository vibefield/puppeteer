import type {
  AgentEvent,
  AgentEventConfidence,
  AgentEventSource,
  AgentEventSourceRef,
} from '@vibefield/puppeteer-core';

export type PiNormalizationDisposition = 'mapped' | 'retained-native' | 'no-output';

export interface PiNormalizedRecord {
  events: AgentEvent[];
  promptId?: string | undefined;
  turnId?: string | undefined;
  timestamp?: string | undefined;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  nativeEvent: unknown;
  disposition: PiNormalizationDisposition;
}

export interface PiObservedMeta {
  cursorStart: number;
  cursorEnd: number;
  sourceGeneration: number;
  replay: boolean;
}

export const piRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export const piString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
export const piNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function piTextContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const result = value
    .map((part) => {
      const item = piRecord(part);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
  return result.length > 0 ? result : undefined;
}

export function piErrorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const body = piRecord(value);
  const direct = piString(body?.errorMessage) ?? piString(body?.message) ?? piString(body?.error);
  if (direct) return direct;
  try {
    return value === undefined ? undefined : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function piNativeEvent(nativeType: string): AgentEvent {
  return { type: 'adapter:native-event', adapter: 'pi', nativeType };
}

export function piSourceRef(sessionId: string, meta: PiObservedMeta, projection: string): AgentEventSourceRef {
  return {
    namespace: 'pi:session-jsonl',
    eventId: `${sessionId}:${meta.sourceGeneration}:${meta.cursorStart}-${meta.cursorEnd}:${projection}`,
    revisionKey: `${meta.sourceGeneration}:${meta.cursorStart}-${meta.cursorEnd}`,
    sourceGeneration: meta.sourceGeneration,
    cursorStart: meta.cursorStart,
    cursorEnd: meta.cursorEnd,
  };
}
