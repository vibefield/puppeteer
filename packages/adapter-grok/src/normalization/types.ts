import type { AgentEvent, AgentEventConfidence, AgentEventSource } from '@vibefield/puppeteer-core';

/** The observer's marker: a launch or resume replay ended, and what it left open is settled. */
export const GROK_REPLAY_SETTLED = 'replay.settled';

export type GrokUpdateMeta = {
  promptId?: string;
  agentTimestampMs?: number;
  totalTokens?: number;
  /** When the model stream that wrote this record began: one value per stream segment of a turn. */
  streamStartMs?: number;
};

export interface GrokUpdate {
  sessionUpdate?: string;
  content?: { type?: string; text?: string };
  messageId?: string;
  toolCallId?: string;
  prompt_id?: string;
  stop_reason?: string;
  /** Set on a refused turn (public TurnCompleted, Option<String>); null or absent otherwise. */
  error_kind?: string | null;
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
  promptId?: string | undefined;
  timestamp?: string | undefined;
  phase?: 'bootstrap' | 'live' | undefined;
  source?: AgentEventSource | undefined;
  confidence?: AgentEventConfidence | undefined;
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
