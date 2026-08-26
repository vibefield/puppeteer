import type { OpenCodeSseRecord } from '../transport/event-stream.js';

export const isOpenCodeRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const openCodeText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const openCodeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export function openCodeTimestamp(...values: unknown[]): string {
  for (const value of values) {
    const milliseconds = openCodeNumber(value);
    if (milliseconds !== undefined) return new Date(milliseconds).toISOString();
  }
  return new Date().toISOString();
}

export function openCodeRecordTimestamp(properties: Record<string, unknown>): string {
  const info = isOpenCodeRecord(properties.info) ? properties.info : undefined;
  const part = isOpenCodeRecord(properties.part) ? properties.part : undefined;
  const infoTime = isOpenCodeRecord(info?.time) ? info.time : undefined;
  const partTime = isOpenCodeRecord(part?.time) ? part.time : undefined;
  return openCodeTimestamp(
    properties.time,
    partTime?.end,
    partTime?.start,
    infoTime?.completed,
    infoTime?.updated,
    infoTime?.created,
  );
}

export function openCodeError(value: unknown): string | undefined {
  if (!isOpenCodeRecord(value)) return openCodeText(value);
  const data = isOpenCodeRecord(value.data) ? value.data : undefined;
  return openCodeText(data?.message) ?? openCodeText(value.message) ?? openCodeText(value.name);
}

export function boundedOpenCodeAdd<T>(set: Set<T>, value: T, maximum: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > maximum) {
    const oldest = set.values().next().value as T | undefined;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

export function boundedOpenCodeMapSet<K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export function openCodeRecordSessionID(record: OpenCodeSseRecord): string | undefined {
  const info = isOpenCodeRecord(record.properties.info) ? record.properties.info : undefined;
  const direct = openCodeText(record.properties.sessionID) ?? openCodeText(info?.sessionID);
  if (direct) return direct;
  const infoID = openCodeText(info?.id);
  return infoID && ['session.created', 'session.updated', 'session.deleted'].includes(record.type) ? infoID : undefined;
}
