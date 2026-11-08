/**
 * `_x.ai/queue/changed` → Grok's prompt queue. The one reader of the frame: the monitor's running prompt, the
 * control rail's turn start and the prompt receipt all read it here.
 *
 * Grok 1.0.70 sends the whole queue at every change (`captures/grok@1.0.70/viewer-session/acp-controller.jsonl`): a
 * prompt is first listed in `entries` (`{id, version, kind, text, position}`), then runs (`runningPromptId`,
 * `runningText`, `runningKind`, and `entries` without it), and the queue empties again before its `turn_completed`.
 * The running id is the native prompt id the durable log's `_meta.promptId` and `turn_completed.prompt_id` carry.
 */

export const GROK_QUEUE_CHANGED_METHOD = '_x.ai/queue/changed';

export interface GrokQueueEntry {
  id: string;
  text?: string | undefined;
  kind?: string | undefined;
}

export interface GrokRunningPrompt {
  promptId: string;
  text?: string | undefined;
  kind?: string | undefined;
}

export interface GrokQueueChanged {
  sessionId?: string | undefined;
  /** The prompts waiting, in queue order. */
  entries: GrokQueueEntry[];
  /** The prompt Grok is running, while one runs. */
  running?: GrokRunningPrompt | undefined;
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const id = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Tolerant decode of a `_x.ai/queue/changed` frame's params; undefined when the params are not an object. */
export function decodeGrokQueueChanged(params: unknown): GrokQueueChanged | undefined {
  const frame = rec(params);
  if (!frame) return undefined;
  const entries = (Array.isArray(frame.entries) ? frame.entries : []).flatMap((value): GrokQueueEntry[] => {
    const entry = rec(value);
    const entryId = id(entry?.id);
    return entryId ? [{ id: entryId, text: text(entry?.text), kind: id(entry?.kind) }] : [];
  });
  const promptId = id(frame.runningPromptId);
  return {
    sessionId: id(frame.sessionId),
    entries,
    ...(promptId ? { running: { promptId, text: text(frame.runningText), kind: id(frame.runningKind) } } : {}),
  };
}
