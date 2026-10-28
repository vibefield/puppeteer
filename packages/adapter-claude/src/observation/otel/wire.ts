/** Tolerant OTLP/HTTP JSON decoding with an explicit PII-safe attribute allow-list. */

export type ClaudeOtelScalar = string | number | boolean;

export interface ClaudeOtelLogRecord {
  receivedAt: string;
  timestamp: string;
  body?: string;
  providerVersion?: string;
  attributes: Readonly<Record<string, ClaudeOtelScalar>>;
}

const SAFE_ATTRIBUTE_NAMES = new Set([
  'event.name',
  'event.timestamp',
  'event.sequence',
  'session.id',
  'prompt.id',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_usd',
  'duration_ms',
  'request_id',
  'client_request_id',
  'speed',
  'query_source',
  'agent.id',
  'agent.name',
  'agent.type',
  'agent_id',
  'agent_type',
  'workflow.run_id',
  'workflow.name',
]);

/**
 * Attributes kept only on the event that defines them: `source` is a permission decision's
 * origin on `tool_decision` alone. Its `tool_parameters` (the command) are never kept.
 */
const SAFE_EVENT_ATTRIBUTE_NAMES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['tool_decision', new Set(['tool_use_id', 'decision', 'source'])],
]);

const SAFE_LOG_BODIES = new Set(['claude_code.api_request', 'claude_code.tool_decision']);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function anyValue(value: unknown): unknown {
  const wrapped = record(value);
  if (!wrapped) return value;
  if ('stringValue' in wrapped) return wrapped.stringValue;
  if ('intValue' in wrapped) {
    const parsed = Number(wrapped.intValue);
    return Number.isSafeInteger(parsed) ? parsed : wrapped.intValue;
  }
  if ('doubleValue' in wrapped) return wrapped.doubleValue;
  if ('boolValue' in wrapped) return wrapped.boolValue;
  if ('arrayValue' in wrapped) {
    return array(record(wrapped.arrayValue)?.values).map(anyValue);
  }
  if ('kvlistValue' in wrapped) {
    return attributes(record(wrapped.kvlistValue)?.values);
  }
  return undefined;
}

function attributes(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const item of array(value)) {
    const entry = record(item);
    if (!entry || typeof entry.key !== 'string') continue;
    result[entry.key] = anyValue(entry.value);
  }
  return result;
}

/** Claude names an event in `event.name`; a safe log body carries the same name as `claude_code.<name>`. */
function eventName(decoded: Record<string, unknown>, body: string | undefined): string | undefined {
  if (typeof decoded['event.name'] === 'string') return decoded['event.name'];
  return body?.startsWith('claude_code.') ? body.slice('claude_code.'.length) : undefined;
}

function safeAttributes(decoded: Record<string, unknown>, name: string | undefined): Record<string, ClaudeOtelScalar> {
  const result: Record<string, ClaudeOtelScalar> = {};
  const eventSafe = name === undefined ? undefined : SAFE_EVENT_ATTRIBUTE_NAMES.get(name);
  for (const [key, candidate] of Object.entries(decoded)) {
    if (!SAFE_ATTRIBUTE_NAMES.has(key) && !eventSafe?.has(key)) continue;
    if (typeof candidate === 'string' || typeof candidate === 'boolean') result[key] = candidate;
    else if (typeof candidate === 'number' && Number.isFinite(candidate)) result[key] = candidate;
  }
  return result;
}

function nanosecondsTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  try {
    const milliseconds = Number(BigInt(value) / 1_000_000n);
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : fallback;
  } catch {
    return fallback;
  }
}

/** Flatten only log records. Metrics and traces contain duplicate token facts and are intentionally ignored. */
export function decodeClaudeOtelLogs(payload: unknown, receivedAt: string): ClaudeOtelLogRecord[] {
  const root = record(payload);
  if (!root) return [];
  const output: ClaudeOtelLogRecord[] = [];
  for (const resourceLogsValue of array(root.resourceLogs)) {
    const resourceLogs = record(resourceLogsValue);
    if (!resourceLogs) continue;
    const resourceAttributes = attributes(record(resourceLogs.resource)?.attributes);
    const providerVersion =
      typeof resourceAttributes['service.version'] === 'string' ? resourceAttributes['service.version'] : undefined;
    for (const scopeLogsValue of array(resourceLogs.scopeLogs)) {
      const scopeLogs = record(scopeLogsValue);
      if (!scopeLogs) continue;
      for (const logRecordValue of array(scopeLogs.logRecords)) {
        const logRecord = record(logRecordValue);
        if (!logRecord) continue;
        const decodedBody = anyValue(logRecord.body);
        const body = typeof decodedBody === 'string' && SAFE_LOG_BODIES.has(decodedBody) ? decodedBody : undefined;
        const decoded = attributes(logRecord.attributes);
        output.push({
          receivedAt,
          timestamp: nanosecondsTimestamp(logRecord.timeUnixNano ?? logRecord.observedTimeUnixNano, receivedAt),
          ...(typeof body === 'string' ? { body } : {}),
          ...(providerVersion ? { providerVersion } : {}),
          attributes: safeAttributes(decoded, eventName(decoded, body)),
        });
      }
    }
  }
  return output;
}

export function otelString(record: ClaudeOtelLogRecord, name: string): string | undefined {
  const value = record.attributes[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function otelNonNegativeNumber(record: ClaudeOtelLogRecord, name: string): number | undefined {
  const value = record.attributes[name];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export function claudeOtelEventTimestamp(record: ClaudeOtelLogRecord): string {
  const timestamp = otelString(record, 'event.timestamp');
  if (timestamp && Number.isFinite(Date.parse(timestamp))) return new Date(timestamp).toISOString();
  return record.timestamp;
}
