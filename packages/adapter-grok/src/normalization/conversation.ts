import type { GrokObservedEvent, GrokObservedFactory, GrokUpdate, GrokUpdateMeta } from './types.js';
import { grokTextContent } from './types.js';

/** The message a prompt is streaming now. */
interface GrokAssistantSegment {
  /** 0 for the turn's first message, which keeps the bare `grok-assistant:<promptId>` id. */
  index: number;
  messageId: string;
  text: string;
  /** The segment's `_meta.streamStartMs`, when its records carry one. */
  streamStartMs: number | undefined;
  /** A thought or tool record of the prompt came after the segment's last message record. */
  interrupted: boolean;
}

/**
 * Grok message records → conversation events, one message per stream segment.
 *
 * Grok 1.0.70 sends no `messageId`. A turn's narration before a tool, after it, and its final answer are
 * separate message records, each streamed on its own (`_meta.streamStartMs`), with a thought or tool record
 * between them. A message record therefore opens a new message once the current one has text and either such a
 * record came between, or both records name their stream and the streams differ. The turn's last message is its
 * final message and its `turn:completed.lastAssistantMessage`, as Claude's Stop hook and Codex's latest item are;
 * messages are never joined.
 */
export class GrokConversationNormalizer {
  private readonly segments = new Map<string, GrokAssistantSegment>();

  append(
    update: GrokUpdate,
    promptId: string,
    observed: GrokObservedFactory,
    meta?: GrokUpdateMeta,
  ): GrokObservedEvent {
    const streamStartMs = finiteNumber(meta?.streamStartMs);
    let segment = this.segments.get(promptId);
    if (!segment || opensSegment(segment, streamStartMs)) {
      const index = segment ? segment.index + 1 : 0;
      const derived = index === 0 ? `grok-assistant:${promptId}` : `grok-assistant:${promptId}:${index}`;
      segment = { index, messageId: update.messageId ?? derived, text: '', streamStartMs, interrupted: false };
      this.segments.set(promptId, segment);
    }
    segment.text += grokTextContent(update);
    segment.streamStartMs = streamStartMs ?? segment.streamStartMs;
    segment.interrupted = false;
    return assistantMessage(segment, promptId, false, observed);
  }

  /** A thought or tool record of the prompt: its next message record opens a new message. */
  interrupt(promptId: string): void {
    const segment = this.segments.get(promptId);
    if (segment) segment.interrupted = true;
  }

  /** The turn's final message; a completed turn's text is not kept. */
  complete(promptId: string, observed: GrokObservedFactory): { events: GrokObservedEvent[]; text?: string } {
    const segment = this.segments.get(promptId);
    if (!segment) return { events: [] };
    this.segments.delete(promptId);
    return { text: segment.text, events: [assistantMessage(segment, promptId, true, observed)] };
  }

  /** A settled replay's unfinished messages are kept by no turn. */
  clear(): void {
    this.segments.clear();
  }
}

function opensSegment(segment: GrokAssistantSegment, streamStartMs: number | undefined): boolean {
  if (segment.text === '') return false;
  if (segment.interrupted) return true;
  return segment.streamStartMs !== undefined && streamStartMs !== undefined && segment.streamStartMs !== streamStartMs;
}

function assistantMessage(
  segment: GrokAssistantSegment,
  promptId: string,
  final: boolean,
  observed: GrokObservedFactory,
): GrokObservedEvent {
  const { messageId, text } = segment;
  return observed(
    { type: 'conversation:assistant-message', messageId, turnId: promptId, text, final, displayOnly: false },
    promptId,
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
