import type { AgentEvent, ToolActivityKind, ToolPresentation } from '@vibefield/puppeteer-core';

export interface CodexServerNotification {
  method: string;
  params?: Record<string, unknown> | undefined;
}

export interface NormalizedNotification {
  events: AgentEvent[];
  threadId?: string | undefined;
  turnId?: string | undefined;
  /** Exact prompt correlation echoed by a completed Codex user-message item. */
  userMessageClientId?: string | null | undefined;
}

export interface CodexNormalizationInput {
  method: string;
  params: Record<string, unknown>;
  threadId?: string | undefined;
  turnId?: string | undefined;
}

export interface CategoryNormalization<Event extends AgentEvent> {
  handled: boolean;
  events: Event[];
}

export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
export const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Text of an item: agentMessage `text`, or a userMessage's `content` text spans. */
export function itemText(item: Record<string, unknown>): string {
  const direct = str(item.text);
  if (direct !== undefined) return direct;
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => (rec(part)?.type === 'text' ? (str(rec(part)?.text) ?? '') : '')).join('');
}

function detailOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join(' ');
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 237)}…` : text;
  } catch {
    return undefined;
  }
}

export function toolPresentation(kind: ToolActivityKind, title: string, detail?: unknown): ToolPresentation {
  return { kind, title, detail: detailOf(detail) };
}
