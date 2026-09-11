import type { AgentEvent, AgentEventConfidence, AgentEventSource } from '@vibecook/puppeteer-core';

export type GrokUpdateMeta = { promptId?: string; agentTimestampMs?: number; totalTokens?: number };

export interface GrokUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  messageId?: string;
  toolCallId?: string;
  prompt_id?: string;
  stop_reason?: string;
  event_name?: string;
  reason?: string;
  subagent_id?: string;
  subagent_type?: string;
  _meta?: { promptId?: string; promptIndex?: number };
  [key: string]: unknown;
}

export interface GrokUpdateRecord {
  timestamp?: number | string;
  method?: string;
  params?: {
    sessionId?: string;
    update?: GrokUpdate;
    _meta?: GrokUpdateMeta;
  };
}

export interface GrokObservedEvent {
  event: AgentEvent;
  promptId?: string;
  timestamp?: string;
  phase?: 'bootstrap' | 'live';
  source?: AgentEventSource;
  confidence?: AgentEventConfidence;
  nativeEvent: unknown;
}

export interface GrokSessionObserver {
  onEvent(listener: (event: GrokObservedEvent) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  poll(): Promise<void>;
  stop(): void;
}

export type GrokObservedFactory = (
  event: AgentEvent,
  promptId?: string,
  source?: AgentEventSource,
  confidence?: AgentEventConfidence,
) => GrokObservedEvent;

export function grokRecordTimestamp(record: GrokUpdateRecord): string | undefined {
  const agentMs = record.params?._meta?.agentTimestampMs;
  if (typeof agentMs === 'number' && Number.isFinite(agentMs)) return new Date(agentMs).toISOString();
  const value = typeof record.timestamp === 'string' ? Number(record.timestamp) : record.timestamp;
  // Durable records use Unix seconds; older fixtures used milliseconds.
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value < 1_000_000_000_000 ? value * 1_000 : value).toISOString()
    : undefined;
}

export function grokTextContent(update: GrokUpdate): string {
  return update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : '';
}
