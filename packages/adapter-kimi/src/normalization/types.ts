import type { AgentEvent, AgentEventConfidence, AgentEventSource, ToolPresentation } from '@vibecook/puppeteer-core';

export interface KimiWireRecord {
  type?: unknown;
  time?: unknown;
  [key: string]: unknown;
}

export type KimiNormalizationDisposition = 'mapped' | 'retained-native' | 'buffered' | 'no-output';

export interface KimiNormalizationContext {
  agentId?: string;
}

export interface KimiNormalizedRecord {
  events: AgentEvent[];
  promptId?: string | undefined;
  turnId?: string | undefined;
  timestamp?: string | undefined;
  source: AgentEventSource;
  confidence: AgentEventConfidence;
  nativeEvent: unknown;
  disposition: KimiNormalizationDisposition;
  explanation?: string | undefined;
}

export interface KimiNormalizedFragment {
  events: AgentEvent[];
  disposition: KimiNormalizationDisposition;
  turnId?: string | undefined;
  explanation?: string | undefined;
}

export interface KimiToolFact {
  tool: string;
  turnId?: string;
  input?: unknown;
  presentation?: ToolPresentation;
}

export const MAX_KIMI_CORRELATIONS = 1_024;

export const kimiRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export const kimiString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export function kimiNativeTurnId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function kimiTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function kimiInputText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => {
      const item = kimiRecord(part);
      if (item?.type === 'text') return kimiString(item.text) ?? '';
      if (item?.type === 'shell') return kimiString(item.command) ?? '';
      return '';
    })
    .join('');
  return text.length > 0 ? text : undefined;
}

export function kimiOriginKind(value: unknown): string | undefined {
  return typeof value === 'string' ? value : kimiString(kimiRecord(value)?.kind);
}

export function boundedKimiSetAdd<T>(target: Set<T>, value: T): void {
  if (!target.has(value) && target.size >= MAX_KIMI_CORRELATIONS) {
    const oldest = target.values().next().value as T | undefined;
    if (oldest !== undefined) target.delete(oldest);
  }
  target.add(value);
}

export function boundedKimiMapSet<K, V>(target: Map<K, V>, key: K, value: V): void {
  if (!target.has(key) && target.size >= MAX_KIMI_CORRELATIONS) {
    const oldest = target.keys().next().value as K | undefined;
    if (oldest !== undefined) target.delete(oldest);
  }
  target.set(key, value);
}

export function kimiErrorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const item = kimiRecord(value);
  const direct = kimiString(item?.message) ?? kimiString(item?.output) ?? kimiString(item?.error);
  if (direct) return direct;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function kimiNativeEvent(nativeType: string): AgentEvent {
  return { type: 'adapter:native-event', adapter: 'kimi', nativeType };
}
